'use strict';
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const uploadDir = path.join(__dirname, 'private', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
if (!process.env.DATABASE_URL || !SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('Configura DATABASE_URL y SESSION_SECRET (mínimo 32 caracteres).'); process.exit(1);
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  name: 'qrs.sid', secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Mitigación básica CSRF: en producción, exigir mismo origen en peticiones que modifican datos.
app.use((req, res, next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && process.env.NODE_ENV === 'production') {
    const origin = req.get('origin');
    if (!origin || origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Origen no permitido.' });
  }
  next();
});
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera 15 minutos.' } });
const auth = (req,res,next) => req.session.userId ? next() : res.status(401).json({ error: 'Inicia sesión para continuar.' });
const safeUser = u => ({ id: u.id, username: u.username, displayName: u.display_name });

app.get('/api/health', async (_req,res) => { try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok:false }); } });
app.post('/api/register', loginLimiter, async (req,res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.displayName || '').trim();
  const pin = String(req.body.pin || '');
  if (!/^[a-z0-9_.-]{4,32}$/.test(username)) return res.status(400).json({ error: 'El usuario debe tener 4–32 caracteres: letras, números, punto, guion o guion bajo.' });
  if (displayName.length < 2 || displayName.length > 100) return res.status(400).json({ error: 'Ingresa tu nombre (2–100 caracteres).' });
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'El PIN debe tener entre 4 y 6 dígitos.' });
  if (/^(\d)\1+$/.test(pin) || ['1234','12345','123456','0000','1111','1212'].includes(pin)) return res.status(400).json({ error: 'Elige un PIN menos predecible.' });
  try {
    const hash = await bcrypt.hash(pin, 12);
    const r = await pool.query('INSERT INTO users(username,display_name,pin_hash) VALUES($1,$2,$3) RETURNING id,username,display_name', [username,displayName,hash]);
    await pool.query('INSERT INTO profiles(user_id,data) VALUES($1,$2)', [r.rows[0].id, {}]);
    req.session.regenerate(err => { if (err) return res.status(500).json({error:'No se pudo iniciar sesión.'}); req.session.userId = r.rows[0].id; res.status(201).json({ user: safeUser(r.rows[0]) }); });
  } catch (e) { if (e.code === '23505') return res.status(409).json({error:'Ese nombre de usuario ya está registrado.'}); console.error(e); res.status(500).json({error:'No se pudo crear la cuenta.'}); }
});
app.post('/api/login', loginLimiter, async (req,res) => {
  const username = String(req.body.username || '').trim().toLowerCase(); const pin = String(req.body.pin || '');
  if (!/^[a-z0-9_.-]{4,32}$/.test(username) || !/^\d{4,6}$/.test(pin)) return res.status(400).json({error:'Usuario o PIN inválido.'});
  try { const r = await pool.query('SELECT id,username,display_name,pin_hash FROM users WHERE username=$1',[username]);
    const ok = r.rowCount && await bcrypt.compare(pin,r.rows[0].pin_hash);
    if (!ok) return res.status(401).json({error:'Usuario o PIN incorrecto.'});
    req.session.regenerate(err => { if(err) return res.status(500).json({error:'No se pudo iniciar sesión.'}); req.session.userId=r.rows[0].id; res.json({user:safeUser(r.rows[0])}); });
  } catch(e) { console.error(e); res.status(500).json({error:'Error al iniciar sesión.'}); }
});
app.post('/api/logout', auth, (req,res) => req.session.destroy(() => { res.clearCookie('qrs.sid'); res.json({ok:true}); }));
app.get('/api/me', auth, async (req,res) => { const r=await pool.query('SELECT id,username,display_name FROM users WHERE id=$1',[req.session.userId]); if(!r.rowCount) return res.status(401).json({error:'Sesión inválida.'}); res.json({user:safeUser(r.rows[0])}); });

app.get('/api/profile', auth, async (req,res) => { const r=await pool.query('SELECT data FROM profiles WHERE user_id=$1',[req.session.userId]); res.json(r.rows[0]?.data || {}); });
// QR personal: token aleatorio no predecible; solo expone campos con consentimiento explícito.
app.get('/api/qr/me', auth, async (req,res) => { let r=await pool.query('SELECT data FROM profiles WHERE user_id=$1',[req.session.userId]); let data=r.rows[0]?.data||{}; if(!data.qrToken){data={...data,qrToken:crypto.randomBytes(32).toString('hex'),qrEnabled:false}; await pool.query('UPDATE profiles SET data=$2,updated_at=NOW() WHERE user_id=$1',[req.session.userId,data]);} const url=`${req.protocol}://${req.get('host')}/emergency/${data.qrToken}`; res.json({url,enabled:data.qrEnabled===true}); });
app.get('/api/qr/image', auth, async (req,res) => { const r=await pool.query('SELECT data FROM profiles WHERE user_id=$1',[req.session.userId]); let data=r.rows[0]?.data||{}; if(!data.qrToken){data={...data,qrToken:crypto.randomBytes(32).toString('hex'),qrEnabled:false}; await pool.query('UPDATE profiles SET data=$2,updated_at=NOW() WHERE user_id=$1',[req.session.userId,data]);} const url=`${req.protocol}://${req.get('host')}/emergency/${data.qrToken}`; res.type('png').send(await QRCode.toBuffer(url,{width:320,margin:2,errorCorrectionLevel:'M'})); });
app.get('/emergency/:token', async (req,res) => { try { const r=await pool.query("SELECT u.display_name,p.data FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.data->>'qrToken'=$1 AND p.data->>'qrEnabled'='true'",[req.params.token]); if(!r.rowCount) return res.status(404).sendFile(path.join(__dirname,'public','qr-unavailable.html')); const d=r.rows[0].data; const fields=[['Grupo sanguíneo','bloodType','shareBloodType'],['Contacto de emergencia','emergencyContact','shareEmergencyContact'],['Alergias','allergies','shareAllergies'],['Condiciones importantes','criticalConditions','shareCriticalConditions'],['Discapacidad / apoyos','disability','shareDisability'],['Notas adicionales','notes','shareNotes']]; const rows=fields.filter(x=>d[x[2]]===true && d[x[1]]).map(x=>`<section><b>${x[0]}</b><p>${String(d[x[1]]).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</p></section>`).join(''); res.set('Cache-Control','no-store').send(`<!doctype html><html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>QR Salud · Emergencia</title><style>body{font:16px system-ui;background:#f3f8f8;color:#102c45;margin:0;padding:24px}.card{max-width:620px;margin:5vh auto;background:white;padding:26px;border-radius:18px}h1{color:#0e7c7b}section{padding:12px 0;border-bottom:1px solid #dce7e9}p{white-space:pre-wrap;margin:6px 0;color:#405568}.note{font-size:13px;color:#607487}</style><main class="card"><h1>QR Salud · Información de emergencia</h1><h2>${String(r.rows[0].display_name).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</h2>${rows||'<p>No hay datos autorizados para mostrar.</p>'}<p class="note">Información compartida voluntariamente por el titular. No reemplaza la atención médica profesional.</p></main></html>`); } catch(e){console.error(e);res.sendStatus(500)} });
app.put('/api/profile', auth, async (req,res) => { const allowed=['bloodType','allergies','criticalConditions','disability','emergencyContact','notes','qrEnabled','shareBloodType','shareEmergencyContact','shareAllergies','shareCriticalConditions','shareDisability','shareNotes']; const data={}; for(const k of allowed) if(req.body[k]!==undefined) data[k]=['qrEnabled','shareBloodType','shareEmergencyContact','shareAllergies','shareCriticalConditions','shareDisability','shareNotes'].includes(k)?req.body[k]===true:String(req.body[k]).slice(0,2000); await pool.query('INSERT INTO profiles(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=profiles.data || EXCLUDED.data, updated_at=NOW()',[req.session.userId,data]); res.json({ok:true}); });

app.get('/api/diagnoses', auth, async (req,res)=>{ const r=await pool.query('SELECT id,name,notes,created_at FROM diagnoses WHERE user_id=$1 ORDER BY created_at DESC',[req.session.userId]); res.json(r.rows); });
app.post('/api/diagnoses', auth, async (req,res)=>{ const name=String(req.body.name||'').trim(); const notes=String(req.body.notes||'').trim(); if(!name||name.length>180) return res.status(400).json({error:'Escribe el diagnóstico o condición.'}); const r=await pool.query('INSERT INTO diagnoses(user_id,name,notes) VALUES($1,$2,$3) RETURNING id,name,notes,created_at',[req.session.userId,name,notes.slice(0,2000)]); res.status(201).json(r.rows[0]); });
app.delete('/api/diagnoses/:id', auth, async (req,res)=>{ await pool.query('DELETE FROM diagnoses WHERE id=$1 AND user_id=$2',[req.params.id,req.session.userId]); res.json({ok:true}); });

app.get('/api/medications', auth, async (req,res)=>{ const r=await pool.query('SELECT id,name,dose,times,start_date,end_date,instructions,active FROM medications WHERE user_id=$1 ORDER BY created_at DESC',[req.session.userId]); res.json(r.rows); });
app.post('/api/medications', auth, async (req,res)=>{ const {name,dose,times,startDate,endDate,instructions}=req.body; const n=String(name||'').trim(), d=String(dose||'').trim(); const ts=Array.isArray(times)?times.filter(t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0,8):[]; if(!n||!d||!ts.length) return res.status(400).json({error:'Indica medicamento, dosis y al menos un horario de la receta.'}); const r=await pool.query('INSERT INTO medications(user_id,name,dose,times,start_date,end_date,instructions) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.session.userId,n,d,JSON.stringify(ts),startDate||null,endDate||null,String(instructions||'').slice(0,1000)]); res.status(201).json(r.rows[0]); });
app.patch('/api/medications/:id', auth, async (req,res)=>{ const active=!!req.body.active; await pool.query('UPDATE medications SET active=$1 WHERE id=$2 AND user_id=$3',[active,req.params.id,req.session.userId]); res.json({ok:true}); });
app.delete('/api/medications/:id', auth, async (req,res)=>{ await pool.query('DELETE FROM medications WHERE id=$1 AND user_id=$2',[req.params.id,req.session.userId]); res.json({ok:true}); });
app.post('/api/dose-logs', auth, async (req,res)=>{ const {medicationId,scheduledAt,status}=req.body; if(!['taken','skipped'].includes(status)||!scheduledAt) return res.status(400).json({error:'Registro inválido.'}); const m=await pool.query('SELECT id FROM medications WHERE id=$1 AND user_id=$2',[medicationId,req.session.userId]); if(!m.rowCount) return res.status(404).json({error:'Medicamento no encontrado.'}); await pool.query('INSERT INTO dose_logs(user_id,medication_id,scheduled_at,status) VALUES($1,$2,$3,$4)',[req.session.userId,medicationId,scheduledAt,status]); res.json({ok:true}); });
app.get('/api/dose-logs', auth, async (req,res)=>{ const r=await pool.query('SELECT l.id,l.scheduled_at,l.status,m.name,m.dose FROM dose_logs l JOIN medications m ON m.id=l.medication_id WHERE l.user_id=$1 ORDER BY l.scheduled_at DESC LIMIT 100',[req.session.userId]); res.json(r.rows); });

const storage=multer.diskStorage({destination:(_req,_file,cb)=>cb(null,uploadDir),filename:(_req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())});
const upload=multer({storage,limits:{fileSize:10*1024*1024,files:5},fileFilter:(_req,file,cb)=>{const ok=['image/jpeg','image/png','application/pdf'].includes(file.mimetype); cb(ok?null:new Error('Solo se permiten imágenes JPG/PNG y PDF.'),ok);}});
app.get('/api/documents', auth, async (req,res)=>{ const r=await pool.query('SELECT id,original_name,mime_type,size_bytes,created_at FROM documents WHERE user_id=$1 ORDER BY created_at DESC',[req.session.userId]); res.json(r.rows); });
app.post('/api/documents', auth, upload.array('files',5), async (req,res)=>{ const saved=[]; for(const f of (req.files||[])){ const r=await pool.query('INSERT INTO documents(user_id,original_name,stored_name,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5) RETURNING id,original_name,mime_type,size_bytes,created_at',[req.session.userId,path.basename(f.originalname).slice(0,240),f.filename,f.mimetype,f.size]); saved.push(r.rows[0]); } res.status(201).json(saved); });
app.get('/api/documents/:id/file', auth, async (req,res)=>{ const r=await pool.query('SELECT stored_name,original_name,mime_type FROM documents WHERE id=$1 AND user_id=$2',[req.params.id,req.session.userId]); if(!r.rowCount) return res.sendStatus(404); const file=path.join(uploadDir,r.rows[0].stored_name); if(!fs.existsSync(file)) return res.sendStatus(404); res.type(r.rows[0].mime_type).set('Content-Disposition',`inline; filename="${encodeURIComponent(r.rows[0].original_name)}"`).sendFile(file); });
app.delete('/api/documents/:id', auth, async (req,res)=>{ const r=await pool.query('DELETE FROM documents WHERE id=$1 AND user_id=$2 RETURNING stored_name',[req.params.id,req.session.userId]); if(r.rowCount) fs.rm(path.join(uploadDir,r.rows[0].stored_name),{force:true},()=>{}); res.json({ok:true}); });

app.use((err,_req,res,_next)=>{ console.error(err); if(err instanceof multer.MulterError) return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Cada archivo debe pesar como máximo 10 MB.':'No se pudo cargar el archivo.'}); res.status(400).json({error:err.message||'Solicitud no válida.'}); });
app.listen(PORT,()=>console.log(`QR Salud escuchando en puerto ${PORT}`));
