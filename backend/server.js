require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const mqtt = require('mqtt');
const XLSX = require('xlsx');
const path = require('path');

// ==========================================
// CONFIGURACIÓN TWILIO (WHATSAPP)
// ==========================================
const accountSid = process.env.TWILIO_ACCOUNT_SID; 
const authToken = process.env.TWILIO_AUTH_TOKEN; // ¡ASEGÚRATE DE TENER ESTO EN TU .ENV!
const clientTwilio = require('twilio')(accountSid, authToken);

const WHATSAPP_FROM = 'whatsapp:+14155238886'; 
const WHATSAPP_TO = 'whatsapp:+59171338567';   

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN DE ENTORNOS ---
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'smigo';

if (!MONGO_URI) {
    console.error("❌ ERROR FATAL: MONGO_URI no está definida.");
    process.exit(1); 
}

const MQTT_BROKER_WEB = process.env.MQTT_BROKER_WEB || 'mqtt://localhost:1883';
const TTN_BROKER = process.env.TTN_BROKER || "mqtts://au1.cloud.thethings.network";
const TTN_PORT = process.env.TTN_PORT || 8883;
const TTN_USER = process.env.TTN_USER || "vacatech@ttn";
const TTN_PASS = process.env.TTN_PASS || "NNSXS.RHLZFYF7EQYAKIOYIW7NAM3XQ4KRFXIECUFUKQQ.5GLTXSXIHUQWVNWBQJPKXM6RJR6KNE4KAMHAO2UFRYRJK2HHM7KQ";
const TTN_TOPIC = process.env.TTN_TOPIC || "v3/vacatech@ttn/devices/+/up";

// --- CONEXIÓN A MONGODB ---
const client = new MongoClient(MONGO_URI);
let db;

async function connectDB() {
    try {
        await client.connect();
        db = client.db(DB_NAME);
        console.log("✅ Base de Datos: Conectada a MongoDB Atlas");
        
        // Iniciamos el monitor de alertas una vez que hay base de datos
        iniciarMonitorAlertas(); 
        
    } catch (error) {
        console.error("❌ Error fatal Mongo:", error);
    }
}
connectDB();

app.use(cors());
app.use(express.json());


// ==========================================
// PUENTE MQTT (SOLO RECEPCIÓN Y GUARDADO)
// ==========================================
const clientWeb = mqtt.connect(MQTT_BROKER_WEB);
clientWeb.on('connect', () => console.log(`✅ Puente Local iniciado en ${MQTT_BROKER_WEB}`));
clientWeb.on('error', (err) => console.error(`❌ Error conectando al Broker WEB: ${err.message}`));

const clientTTN = mqtt.connect(TTN_BROKER, {
    port: TTN_PORT,
    username: TTN_USER,
    password: TTN_PASS,
    protocol: 'mqtts',
    rejectUnauthorized: false
});

clientTTN.on('connect', () => {
    console.log("✅ Conectado a TTN (Nube)");
    clientTTN.subscribe(TTN_TOPIC, (err) => {
        if (err) console.error(`❌ Error conexión TTN: ${err.message}`);
    });
});
clientTTN.on('error', (err) => console.error(`❌ Error cliente TTN: ${err.message}`));


// --- PROCESAMIENTO MQTT ---
clientTTN.on('message', async (topic, message) => {
    try {
        const msgString = message.toString();
        const mensajeJson = JSON.parse(msgString);

        if (mensajeJson.uplink_message && mensajeJson.uplink_message.decoded_payload) {
            
            const datos = mensajeJson.uplink_message.decoded_payload;
            const devId = mensajeJson.end_device_ids.device_id;

            const ax = parseFloat(datos.aceleracion_x || 0.0);
            const ay = parseFloat(datos.aceleracion_y || 0.0);
            const az = parseFloat(datos.aceleracion_z || 0.0);
            const gx = parseFloat(datos.giro_x || 0.0);
            const gy = parseFloat(datos.giro_y || 0.0);
            const gz = parseFloat(datos.giro_z || 0.0);
            const temp = parseFloat(datos.temperatura || datos.temp || 0.0);
            const hum = parseFloat(datos.humedad || 0.0);

            // 1. Calcular ITH en el momento de recepción
            const ithCalculado = calcularITH(temp, hum);

            const registroData = {
                dispositivo: devId,
                giro_x: gx, giro_y: gy, giro_z: gz,
                aceleracion_x: ax, aceleracion_y: ay, aceleracion_z: az,
                temperatura: temp,
                humedad: hum,
                ith: ithCalculado, // <--- Guardamos el ITH en la BD
                fecha_registro: new Date()
            };

            // 2. Solo Guardar en BD (El análisis se hace aparte cada 3 min)
            if (db) {
                await db.collection('datos_vaca').insertOne(registroData);
                console.log(`📦 Dato guardado: ${devId} | ITH: ${ithCalculado.toFixed(2)}`);
            }
        }
    } catch (e) {
        console.error(`⚠️ Error procesando mensaje: ${e.message}`);
    }
});


// ==========================================
// SISTEMA DE MONITOREO AUTOMÁTICO (CRON)
// ==========================================

function iniciarMonitorAlertas() {
    console.log("⏱️  Monitor de Alertas iniciado (Ciclo de 3 minutos)");
    
    // Ejecutar inmediatamente al inicio
    ejecutarAnalisisPeriodico();

    // Programar repetición cada 3 minutos (3 * 60 * 1000 ms)
    setInterval(ejecutarAnalisisPeriodico, 3 * 60 * 1000);
}

async function ejecutarAnalisisPeriodico() {
    if (!db) return;

    console.log("\n🔍 [MONITOR] Iniciando análisis de 3 minutos...");

    try {
        const now = new Date();
        const threeMinutesAgo = new Date(now.getTime() - 3 * 60000);

        // 1. Obtener datos de los últimos 3 minutos
        const datosRecientes = await db.collection('datos_vaca')
            .find({ fecha_registro: { $gte: threeMinutesAgo } })
            .toArray();

        if (datosRecientes.length === 0) {
            console.log("   [MONITOR] No hay datos recientes para analizar.");
            return;
        }

        // 2. Evaluar Estado (usando lógica de Excel)
        const rangos = cargarRangosExcel();
        const estadoAnalizado = evaluarEstadoCola(datosRecientes, rangos);

        // 3. Calcular ITH Promedio del periodo (Más preciso que usar solo el último)
        // Sumamos todos los ITHs y dividimos por la cantidad
        const sumaIth = datosRecientes.reduce((acc, curr) => acc + (curr.ith || 0), 0);
        const promedioIth = sumaIth / datosRecientes.length;

        const devId = datosRecientes[0].dispositivo; // Tomamos el ID del primer registro

        console.log(`   [RESULTADO] Estado: ${estadoAnalizado} | ITH Promedio: ${promedioIth.toFixed(2)}`);

        // 4. CONDICIÓN DE ALERTA SOLICITADA
        // Se envía mensaje SI: ITH >= 88 Y Estado es "Cola levantada"
        if (promedioIth >= 88 && estadoAnalizado === "Cola levantada") {
            console.log("   🚨 ¡CONDICIONES CRÍTICAS CUMPLIDAS! Enviando WhatsApp...");
            await enviarAlertaWhatsApp(promedioIth, estadoAnalizado, devId);
        } else {
            console.log(`   ✅ Condiciones normales. No se envía mensaje, Estado: ${estadoAnalizado} | ITH Promedio: ${promedioIth.toFixed(2)}`);
        }

        /*if (promedioIth >= 30){
            console.log("   🚨 ¡CONDICIONES CRÍTICAS CUMPLIDAS! Enviando WhatsApp...");
            await enviarAlertaWhatsApp(promedioIth, estadoAnalizado, devId);
        } */

    } catch (error) {
        console.error("❌ Error en el monitor de alertas:", error);
    }
}

// Función de Envío
async function enviarAlertaWhatsApp(ith, estado, devId) {
    const fechaHora = new Date().toLocaleString('es-BO', { timeZone: 'America/La_Paz' });
    
    const mensajePlantilla = 
`🚨 *ALERTA CRÍTICA - VACATECH* 🚨

🐮 *Dispositivo:* ${devId}
⚠️ *Estado Detectado:* ${estado}
🌡️ *Índice ITH:* ${ith.toFixed(2)} (Nivel Peligroso > 88)
📅 *Fecha:* ${fechaHora}

*Acción recomendada:* Revisar al animal inmediatamente. Posible inicio de parto bajo estrés calórico.`;

    try {
        const message = await clientTwilio.messages.create({
            body: mensajePlantilla,
            from: WHATSAPP_FROM,
            to: WHATSAPP_TO
        });
        console.log(`📲 WhatsApp enviado. SID: ${message.sid}`);
    } catch (error) {
        console.error("❌ Error enviando WhatsApp:", error.message);
    }
}


// ==========================================
// FUNCIONES AUXILIARES (Lógica Matemática)
// ==========================================

function calcularITH(temp, hum) {
    return (1.8 * temp + 32) - (0.55 - 0.0055 * hum) * (1.8 * temp - 26);
}

function cargarRangosExcel() {
    const archivo = XLSX.readFile(path.join(__dirname, 'tabla_cola.xlsx'));
    const hoja = archivo.Sheets[archivo.SheetNames[0]]; 
    const rangos = XLSX.utils.sheet_to_json(hoja, { header: 1 });
    const p = (val) => parseFloat(val);

    const extraerRangos = (inicio) => {
        return {
            giro_x: { min: p(rangos[inicio + 1][1]), max: p(rangos[inicio + 2][1]) },
            giro_y: { min: p(rangos[inicio + 1][2]), max: p(rangos[inicio + 2][2]) },
            giro_z: { min: p(rangos[inicio + 1][3]), max: p(rangos[inicio + 2][3]) }
        };
    };

    const datosNormal = extraerRangos(0);
    const datosColaLevantada = extraerRangos(4); 
    const datosVacaHechada = extraerRangos(8);   

    return { datosNormal, datosColaLevantada, datosVacaHechada };
}

function evaluarEstadoCola(datos, rangos) {
    if (!datos || datos.length === 0) return "Desconocido";

    let conteo = { "Normal": 0, "Cola levantada": 0, "Vaca hechada": 0, "Desconocido": 0 };
    const normal = rangos.datosNormal;
    const alerta = rangos.datosColaLevantada;
    const hechada = rangos.datosVacaHechada;

    const dentro = (r, d) => 
        d.giro_x >= r.giro_x.min && d.giro_x <= r.giro_x.max &&
        d.giro_y >= r.giro_y.min && d.giro_y <= r.giro_y.max &&
        d.giro_z >= r.giro_z.min && d.giro_z <= r.giro_z.max;

    datos.forEach((registro) => {
        if (dentro(hechada, registro)) conteo["Vaca hechada"]++;
        else if (dentro(alerta, registro)) conteo["Cola levantada"]++;
        else if (dentro(normal, registro)) conteo["Normal"]++;
        else conteo["Desconocido"]++;
    });

    const total = datos.length;
    const umbralAlerta = total * 0.2; 

    if (conteo["Vaca hechada"] > umbralAlerta) return "Vaca hechada";
    if (conteo["Cola levantada"] > umbralAlerta) return "Cola levantada";
    if (conteo["Normal"] > 0) return "Normal";
    return "Desconocido";
}


// ==========================================
// API REST (ENDPOINTS)
// ==========================================

app.get('/analisis_cola', async (req, res) => {
    try {
        const now = new Date();
        const threeMinutesAgo = new Date(now.getTime() - 3 * 60000);

        const datosRecientes = await db.collection('datos_vaca')
            .find({ fecha_registro: { $gte: threeMinutesAgo } })
            .project({ giro_x: 1, giro_y: 1, giro_z: 1, _id: 0 })
            .toArray();

        if (datosRecientes.length === 0) {
            return res.json({ estado: "Sin datos", mensaje: "Esperando conexión del dispositivo..." });
        }

        const rangos = cargarRangosExcel();
        const estado = evaluarEstadoCola(datosRecientes, rangos);

        let respuesta = { estado: "Desconocido", mensaje: "Analizando patrones..." };

        if (estado === "Normal") respuesta = { estado: "Normal", mensaje: "La cola está en posición normal." };
        else if (estado === "Cola levantada") respuesta = { estado: "Cola levantada", mensaje: "¡Alerta! La cola está levantada." };
        else if (estado === "Vaca hechada") respuesta = { estado: "Vaca hechada", mensaje: "¡Advertencia! La vaca está echada." };
        else if (estado === "Desconocido") respuesta = { estado: "Normal", mensaje: "Lecturas fuera de rango, asumiendo normalidad." };

        res.json(respuesta);
    } catch (error) {
        console.error("Error al procesar el análisis:", error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/ultimo_dato', async (req, res) => {
     if (!db) return res.status(500).json({ error: "Error de conexión con la base de datos" });
    try {
        const ultimoDato = await db.collection('datos_vaca').find({}).sort({ fecha_registro: -1 }).limit(1).toArray();
        if (ultimoDato.length > 0) res.json(ultimoDato[0]);
        else res.status(404).json({ mensaje: "No hay datos registrados" });
    } catch (error) { res.status(500).json({ error: "Error al obtener los datos" }); }
});

app.get('/datos_vaca/ultimo', async (req, res) => {
    if (!db) return res.status(500).json({ error: "Error de conexión con la base de datos" });
    try {
        const ultimoDato = await db.collection('datos_vaca').find({}).sort({ fecha_registro: -1 }).limit(1).toArray();
        if (ultimoDato.length > 0) res.json(ultimoDato[0]);
        else res.status(404).json({ mensaje: "No hay datos registrados" });
    } catch (error) { res.status(500).json({ error: "Error al obtener los datos" }); }
});

app.post('/registro', async (req, res) => {
    const { email, password, nombre } = req.body;
    if (!db) return res.status(500).json({ status: 'error', mensaje: 'Error de conexión con Base de Datos' });
    if (!email || !password || !nombre) return res.status(400).json({ status: 'error', mensaje: 'Faltan datos' });
    try {
        const collection = db.collection('usuario'); 
        const existe = await collection.findOne({ email });
        if (existe) return res.status(400).json({ status: 'error', mensaje: 'El correo ya está registrado' });
        const nuevoUsuario = { nombre, email, password, fecha_creacion: new Date() };
        const result = await collection.insertOne(nuevoUsuario);
        res.json({ status: 'ok', mensaje: 'Usuario registrado con éxito', id: result.insertedId });
    } catch (e) { res.status(500).json({ status: 'error', mensaje: 'Error interno al registrar' }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!db) return res.status(500).json({ status: 'error', mensaje: 'Error de conexión con Base de Datos' });
    if (!email || !password) return res.status(400).json({ status: 'error', mensaje: 'Faltan credenciales' });
    try {
        const collection = db.collection('usuario');
        const user = await collection.findOne({ email, password });
        if (user) {
            console.log(`✅ Login exitoso: ${user.nombre}`);
            res.json({ status: 'ok', mensaje: 'Login exitoso', nombre: user.nombre, id: user._id });
        } else {
            res.status(401).json({ status: 'error', mensaje: 'Correo o contraseña incorrectos' });
        }
    } catch (e) { res.status(500).json({ status: 'error', mensaje: 'Error interno al iniciar sesión' }); }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Node.js corriendo en puerto ${PORT}`);
    console.log("   (Esperando datos de TTN...)");
});