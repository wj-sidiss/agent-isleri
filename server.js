// Agent İşleri / Ajan Odası — işi ücretsiz agent'lar yapar (aynı anda, her agent kendi görevinde),
// Codex denetler ve gerekeni düzeltir (ChatGPT aboneliği), Claude en sonda kalite kontrolüne bakar.
// Bağımlılık yok: sadece Node.js. Çalıştır: node server.js
//   http://127.0.0.1:4545       eski görev paneli
//   http://127.0.0.1:4545/oda   Ajan Odası (iş akışı + token sayaçları)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PORT = 4545;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'gorevler.json');
const JOBS_FILE = path.join(ROOT, 'isler.json');
const KIYAS_FILE = path.join(ROOT, 'kiyas.json');
const RESULTS_DIR = path.join(ROOT, 'sonuclar');
const WORK_DIR = path.join(ROOT, 'calisma');
const FONT_DIR = path.join(process.env.USERPROFILE || '', 'Desktop', 'cyberpower', 'video', 'assets', 'fonts');
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // bir görev en fazla 30 dk
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000; // kota biten agent 1 saat dinlenir
fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

// ---- Araçlar ----
const NPM_ROOT = execSync('npm root -g').toString().trim();
// Gemini CLI ve Qwen Code çıkarıldı: ikisinin de ücretsiz planı 2026'da kapandı.
const OPENCODE = path.join(NPM_ROOT, 'opencode-ai', 'bin', 'opencode.exe');
const OLLAMA = path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
const OLLAMA_MODEL = 'qwen2.5-coder:7b';
const CLAUDE = path.join(NPM_ROOT, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
function codexYolu() {
  // Codex masaüstü uygulaması kendi komut satırı aracını taşır; klasör adı güncellemeyle değişebilir
  const kok = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  try {
    for (const d of fs.readdirSync(kok)) {
      const p = path.join(kok, d, 'codex.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return 'codex';
}
const CODEX = codexYolu();
const CODEX_MODEL = 'gpt-6-luna';

// ---- Ücretsiz agent tanımları ----
const AGENTS = [
  {
    id: 'antigravity',
    name: 'Antigravity CLI',
    model: 'Antigravity',
    entry: path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
    args: (prompt) => ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'],
  },
  {
    id: 'opencode-glm',
    name: 'OpenCode',
    model: 'GLM 5.3 Flash',
    entry: OPENCODE,
    args: (prompt, t) => ['run', prompt, '-m', 'opencode/glm-5.3-flash-free', '--auto', '--dir', t.workdir],
  },
  {
    id: 'opencode-deepseek',
    name: 'OpenCode',
    model: 'DeepSeek V4.1 Flash',
    entry: OPENCODE,
    args: (prompt, t) => ['run', prompt, '-m', 'opencode/deepseek-v4.1-flash-free', '--auto', '--dir', t.workdir],
  },
  {
    // Yerel ve sınırsız ama dosya yazamaz: sadece metin cevap verir, cevap sonuç dosyasına kaydedilir.
    id: 'ollama',
    name: 'Ollama (yerel)',
    model: 'Qwen2.5 Coder 7B',
    entry: OLLAMA,
    args: () => ['run', OLLAMA_MODEL],
    stdinPrompt: true,
    textOnly: true,
  },
];
const agentState = {}; // id -> { cooldownUntil, note }
for (const a of AGENTS) agentState[a.id] = { cooldownUntil: 0, note: '' };

const QUOTA_RE = /429|quota|rate.?limit|resource.?exhausted|exhausted|too many requests|capacity|daily limit|usage limit/i;
const AUTH_RE = /login|log in|authenticat|unauthori[sz]ed|401|403|credentials|api key|oauth|sign in/i;
const clean = (d) => d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[⠀-⣿] ?/g, '');

// ---- Durum ----
const oku = (f, bos) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return bos; } };
let tasks = oku(STATE_FILE, []);
let jobs = oku(JOBS_FILE, []);
let kiyas = oku(KIYAS_FILE, null);
for (const t of tasks) if (t.status === 'calisiyor') { t.status = 'bekliyor'; t.log += '\n[sunucu yeniden başladı, görev tekrar sıraya alındı]\n'; }
const zamanlayici = {};
function kaydet(dosya, veri) {
  clearTimeout(zamanlayici[dosya]);
  zamanlayici[dosya] = setTimeout(() => fs.writeFileSync(dosya, JSON.stringify(veri(), null, 2)), 300);
}
const save = () => kaydet(STATE_FILE, () => tasks);
const saveJobs = () => kaydet(JOBS_FILE, () => jobs);
const saveKiyas = () => kaydet(KIYAS_FILE, () => kiyas);

const running = new Map(); // agentId -> { task, child, timer }

function agentHazir(a) {
  return fs.existsSync(a.entry) && agentState[a.id].cooldownUntil <= Date.now();
}

function uygunMu(task, agent) {
  if ((task.failedAgents || []).includes(agent.id)) return false;
  if (agent.textOnly && !task.metinIsi && task.pref !== agent.id) return false; // yerel model dosya yazamaz
  const pref = task.pref && task.pref !== 'otomatik' ? AGENTS.find((a) => a.id === task.pref) : null;
  // tercih edilen agent kurulu ve kotası varsa onu bekle; kotası bittiyse iş başkasına devredilir
  if (pref && pref.id !== agent.id && agentHazir(pref) && !(task.failedAgents || []).includes(pref.id)) return false;
  return true;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9ğüşıöç]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'gorev';
}

function buildPrompt(task, isHandoff) {
  let p = task.text;
  p += `\n\n---\nÇalışma klasörün: ${task.workdir}\nOluşturduğun dosyaları bu klasöre kaydet. İşin bitince ne yaptığını Türkçe ve kısa özetle.`;
  if (isHandoff) {
    p += `\n\nNOT: Bu görev üzerinde başka bir agent çalışıyordu ama yarıda kaldı (kota bitti ya da hata verdi). ` +
      `Önce klasördeki mevcut dosyalara bak, yapılmış olanı tekrar yapma, kaldığı yerden devam et.\n` +
      `Önceki agent'ın son çıktısı:\n${task.log.slice(-3000)}`;
  }
  return p;
}

function finish(task, status, msg) {
  task.status = status;
  task.finishedAt = Date.now();
  if (msg) task.log += `\n[${msg}]\n`;
  if (status === 'bitti') {
    const file = path.join(RESULTS_DIR, `${task.id}-${slug(task.baslik || task.text)}.md`);
    fs.writeFileSync(file, `# Görev\n\n${task.text}\n\n# Agent: ${task.agent}\n\n# Çıktı\n\n${task.output || ''}\n\nÇalışma klasörü: ${task.workdir}\n`);
    task.resultFile = file;
    // metin işi (dosya yazamayan yerel model): cevabı çalışma klasörüne de koy
    if (task.metinDosyasi) fs.writeFileSync(path.join(task.workdir, task.metinDosyasi), (task.output || '').trim() + '\n');
  }
  save();
  if (task.isId) isKontrol(task.isId);
}

function start(task, agent) {
  const tried = task.triedAgents || [];
  const isHandoff = tried.length > 0;
  task.triedAgents = [...tried, agent.id];
  task.agent = `${agent.name} · ${agent.model}`;
  task.agentId = agent.id;
  task.status = 'calisiyor';
  task.startedAt = task.startedAt || Date.now();
  task.log += `\n=== ${task.agent} başladı (${new Date().toLocaleTimeString('tr-TR')}) ===\n`;
  task.output = '';
  fs.mkdirSync(task.workdir, { recursive: true });
  save();

  let prompt = buildPrompt(task, isHandoff);
  if (agent.textOnly) prompt += '\n\nNOT: Dosya oluşturamıyorsun. İstenen içeriği doğrudan cevap olarak yaz; cevabın otomatik olarak kaydedilecek.';
  const args = agent.args(prompt, task);
  const child = spawn(agent.entry, args, {
    cwd: task.workdir,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    windowsHide: true,
  });
  if (agent.stdinPrompt) child.stdin.write(prompt);
  child.stdin.end();
  let stderr = '';
  child.stdout.on('data', (d) => { const s = clean(d); task.output += s; task.log += s; save(); });
  child.stderr.on('data', (d) => { const s = clean(d); stderr += s; task.log += s; save(); });
  const timer = setTimeout(() => { task.log += '\n[zaman aşımı, durduruluyor]\n'; child.kill(); }, TASK_TIMEOUT_MS);
  running.set(agent.id, { task, child, timer });

  child.on('close', (code) => {
    clearTimeout(timer);
    running.delete(agent.id);
    if (task.status === 'iptal') { save(); return schedule(); }
    const all = stderr + '\n' + task.output.slice(-2000);
    if (code === 0 && task.output.trim()) {
      agentState[agent.id].note = '';
      finish(task, 'bitti', `${task.agent} bitirdi`);
    } else {
      if (QUOTA_RE.test(all)) {
        agentState[agent.id].cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
        agentState[agent.id].note = 'Kota bitti';
        task.log += `\n[${task.agent} kotası bitti, sıradaki agent devralıyor]\n`;
      } else if (AUTH_RE.test(all)) {
        agentState[agent.id].cooldownUntil = Date.now() + 10 * 60 * 1000;
        agentState[agent.id].note = 'Giriş gerekli';
        task.log += `\n[${task.agent} giriş istiyor, sıradaki agent devralıyor]\n`;
      } else {
        task.log += `\n[${task.agent} hata verdi (kod ${code}), sıradaki agent deneniyor]\n`;
        task.failedAgents = [...(task.failedAgents || []), agent.id];
      }
      task.status = 'bekliyor';
      save();
    }
    schedule();
  });
}

// Her boş agent'a uygun bekleyen bir görev ver (agent'lar aynı anda çalışır)
function schedule() {
  for (const agent of AGENTS) {
    if (running.has(agent.id) || !agentHazir(agent)) continue;
    const task = tasks.find((t) => t.status === 'bekliyor' && uygunMu(t, agent));
    if (task) start(task, agent);
  }
  for (const t of tasks.filter((x) => x.status === 'bekliyor')) {
    const olasi = AGENTS.some((a) => fs.existsSync(a.entry) && !(t.failedAgents || []).includes(a.id) && (!a.textOnly || t.metinIsi || t.pref === a.id));
    if (!olasi) finish(t, 'hata', 'Hiçbir agent bu görevi bitiremedi');
  }
}

// Kotası biten agent açılınca bekleyen işleri tekrar dene
setInterval(schedule, 60 * 1000);

// ---- İş akışı: ücretsiz agent'lar → Codex denetimi → Claude son kontrol ----
function isKontrol(isId) {
  const job = jobs.find((j) => j.id === isId);
  if (!job || job.asama !== 'ajanlar') return;
  const ts = tasks.filter((t) => t.isId === job.id);
  if (ts.some((t) => t.status === 'bekliyor' || t.status === 'calisiyor')) return;
  if (!ts.some((t) => t.status === 'bitti')) { job.asama = 'hata'; job.not = 'Hiçbir görev bitmedi'; return saveJobs(); }
  job.ajanBitis = Date.now();
  codexBaslat(job);
}

function ozetSatirlari(job) {
  return tasks.filter((t) => t.isId === job.id).map((t) => `- ${t.baslik || t.text.slice(0, 80)} → ${t.agent || '-'} (${t.status})`).join('\n');
}

function codexBaslat(job) {
  job.asama = 'codex';
  job.codex = { durum: 'calisiyor', log: '', basla: Date.now(), usage: null };
  saveJobs();
  const prompt = `${job.codexIstem}\n\nÜcretsiz agent'ların yaptığı işler:\n${ozetSatirlari(job)}`;
  const sonDosya = path.join(RESULTS_DIR, `${job.id}-codex-rapor.md`);
  // Kullanıcı ayarındaki MCP sunucuları yüklenmesin (gereksiz token): --ignore-user-config, model ve giriş aynı kalır.
  // Windows'ta komut çalıştırabilmesi için kullanıcı ayarındaki "elevated" sandbox burada ayrıca verilir.
  const args = ['exec', '--json', '--ignore-user-config', '-c', 'windows.sandbox="elevated"', '-m', CODEX_MODEL, '-c', 'model_reasoning_effort="medium"',
    '-C', job.workdir, '-s', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '-o', sonDosya, prompt];
  const child = spawn(CODEX, args, { cwd: job.workdir, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
  child.stdin.end();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { codexOlay(job, buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', (d) => { const s = clean(d); if (!/rmcp::transport|AuthRequired/.test(s)) job.codex.log += s; saveJobs(); });
  child.on('close', (code) => {
    job.codex.durum = code === 0 ? 'bitti' : 'hata';
    job.codex.bitis = Date.now();
    try { job.codex.ozet = fs.readFileSync(sonDosya, 'utf8'); } catch {}
    saveJobs();
    claudeBaslat(job);
  });
}

function codexOlay(job, satir) {
  let e;
  try { e = JSON.parse(satir); } catch { if (satir.trim()) job.codex.log += satir + '\n'; return; }
  if (e.type === 'turn.completed' && e.usage) {
    const u = job.codex.usage || { input: 0, cached: 0, output: 0 };
    u.input += e.usage.input_tokens || 0;
    u.cached += e.usage.cached_input_tokens || 0;
    u.output += (e.usage.output_tokens || 0) + (e.usage.reasoning_output_tokens || 0);
    job.codex.usage = u;
  }
  const it = e.item;
  if (it && e.type === 'item.completed') {
    if (it.type === 'agent_message' && it.text) job.codex.log += `● ${it.text.trim()}\n`;
    else if (it.type === 'command_execution') job.codex.log += `$ ${it.command || ''}${it.exit_code !== undefined ? `  → çıkış ${it.exit_code}` : ''}\n`;
    else if (it.type === 'file_change') job.codex.log += `✎ ${(it.changes || []).map((c) => c.path).join(', ')}\n`;
    else if (it.type === 'reasoning') job.codex.log += '… düşünüyor\n';
  }
  saveJobs();
}

// Claude'u stream-json ile çalıştırır; canlı kayıt + sonda gerçek token ve maliyet
function claudeCalistir(hedef, prompt, cwd, bitince) {
  hedef.durum = 'calisiyor';
  hedef.log = '';
  hedef.basla = Date.now();
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  const child = spawn(CLAUDE, args, { cwd, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
  child.stdin.end();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const satir = buf.slice(0, i); buf = buf.slice(i + 1);
      let e; try { e = JSON.parse(satir); } catch { continue; }
      if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
        for (const c of e.message.content) {
          if (c.type === 'text' && c.text) hedef.log += `● ${c.text.trim()}\n`;
          if (c.type === 'tool_use') hedef.log += `$ ${c.name}(${JSON.stringify(c.input).slice(0, 160)})\n`;
        }
      }
      if (e.type === 'result') {
        const u = e.usage || {};
        hedef.usage = {
          input: (u.input_tokens || 0), cacheWrite: (u.cache_creation_input_tokens || 0), cacheRead: (u.cache_read_input_tokens || 0), output: (u.output_tokens || 0),
        };
        hedef.toplamToken = hedef.usage.input + hedef.usage.cacheWrite + hedef.usage.cacheRead + hedef.usage.output;
        hedef.maliyet = e.total_cost_usd;
        hedef.ozet = e.result;
        hedef.tur = e.num_turns;
      }
      bitince.kaydet();
    }
  });
  child.stderr.on('data', (d) => { hedef.log += clean(d); bitince.kaydet(); });
  child.on('close', (code) => {
    hedef.durum = code === 0 && hedef.usage ? 'bitti' : 'hata';
    hedef.bitis = Date.now();
    bitince.kaydet();
    bitince.son();
  });
}

function claudeBaslat(job) {
  job.asama = 'claude';
  job.claude = {};
  saveJobs();
  const prompt = `${job.claudeIstem}\n\nÜcretsiz agent'ların yaptığı işler:\n${ozetSatirlari(job)}\n\nCodex denetim raporu:\n${(job.codex && job.codex.ozet) || '(rapor yok)'}`;
  claudeCalistir(job.claude, prompt, job.workdir, {
    kaydet: saveJobs,
    son: () => { job.asama = job.claude.durum === 'bitti' ? 'bitti' : 'hata'; job.bitis = Date.now(); saveJobs(); },
  });
}

// ---- HTTP ----
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function yeniGorev({ text, workdir, pref, isId, baslik, metinIsi, metinDosyasi }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const t = { id, text, workdir, pref: pref || 'otomatik', status: 'bekliyor', log: '', createdAt: Date.now(), triedAgents: [] };
  if (isId) t.isId = isId;
  if (baslik) t.baslik = baslik;
  if (metinIsi) t.metinIsi = true;
  if (metinDosyasi) t.metinDosyasi = metinDosyasi;
  tasks.push(t);
  return t;
}

function agentDurumu() {
  const now = Date.now();
  return AGENTS.map((a) => {
    const r = running.get(a.id);
    return {
      id: a.id, name: a.name, model: a.model,
      installed: fs.existsSync(a.entry),
      busy: !!r,
      gorev: r ? (r.task.baslik || r.task.text.slice(0, 60)) : '',
      kayit: r ? r.task.log.slice(-1200) : '',
      cooldownMin: Math.max(0, Math.ceil((agentState[a.id].cooldownUntil - now) / 60000)),
      note: agentState[a.id].note,
    };
  });
}

const MIME = { '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'panel.html')));
  }
  if (req.method === 'GET' && url.pathname === '/oda') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'oda.html')));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
    const f = path.join(FONT_DIR, path.basename(url.pathname));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(f));
  }
  if (req.method === 'GET' && url.pathname === '/api/durum') {
    return json(res, 200, {
      agents: agentDurumu(),
      tasks: tasks.slice().reverse().map((t) => ({ ...t, log: t.log.slice(-8000), output: undefined })),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/oda') {
    const job = jobs.length ? jobs[jobs.length - 1] : null;
    return json(res, 200, {
      agents: agentDurumu(),
      codexKurulu: fs.existsSync(CODEX),
      claudeKurulu: fs.existsSync(CLAUDE),
      is: job ? {
        ...job,
        gorevler: tasks.filter((t) => t.isId === job.id).map((t) => ({ id: t.id, baslik: t.baslik, agent: t.agent, agentId: t.agentId, status: t.status, sure: t.finishedAt && t.startedAt ? Math.round((t.finishedAt - t.startedAt) / 1000) : null, kayit: t.log.slice(-1500) })),
        codex: job.codex ? { ...job.codex, log: (job.codex.log || '').slice(-3000) } : null,
        claude: job.claude ? { ...job.claude, log: (job.claude.log || '').slice(-3000) } : null,
      } : null,
      kiyas: kiyas ? { ...kiyas, log: (kiyas.log || '').slice(-2000) } : null,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/gorev') {
    const b = await body(req);
    const text = (b.text || '').trim();
    if (!text) return json(res, 400, { error: 'Görev boş' });
    let workdir = (b.workdir || '').trim();
    if (workdir && !fs.existsSync(workdir)) return json(res, 400, { error: 'Klasör bulunamadı: ' + workdir });
    const t = yeniGorev({ text, workdir: workdir || path.join(WORK_DIR, Date.now().toString(36)), pref: b.pref });
    save();
    schedule();
    return json(res, 200, { id: t.id });
  }
  // Oda işi: { baslik, workdir, gorevler: [{ baslik, text, pref, metinIsi, metinDosyasi }], codexIstem, claudeIstem }
  if (req.method === 'POST' && url.pathname === '/api/is') {
    const b = await body(req);
    const workdir = (b.workdir || '').trim();
    if (!workdir || !fs.existsSync(workdir)) return json(res, 400, { error: 'Klasör bulunamadı: ' + workdir });
    if (!Array.isArray(b.gorevler) || !b.gorevler.length) return json(res, 400, { error: 'Görev listesi boş' });
    const job = { id: 'is' + Date.now().toString(36), baslik: b.baslik || 'İş', workdir, asama: 'ajanlar', codexIstem: b.codexIstem, claudeIstem: b.claudeIstem, createdAt: Date.now() };
    jobs.push(job);
    for (const g of b.gorevler) yeniGorev({ ...g, workdir, isId: job.id });
    save();
    saveJobs();
    schedule();
    return json(res, 200, { id: job.id });
  }
  // Denetimi yeniden çalıştır: ücretsiz agent'ların işi durur, Codex → Claude aşamaları baştan yapılır { id? }
  if (req.method === 'POST' && url.pathname === '/api/denetle') {
    const b = await body(req);
    const job = b.id ? jobs.find((j) => j.id === b.id) : jobs[jobs.length - 1];
    if (!job) return json(res, 404, { error: 'İş yok' });
    if (job.asama === 'codex' || job.asama === 'claude') return json(res, 400, { error: 'Denetim zaten sürüyor' });
    delete job.claude;
    codexBaslat(job);
    return json(res, 200, { ok: true });
  }
  // Kıyas: aynı işi tek başına Claude yapsa kaç token / kaç dolar? { istem, workdir }
  if (req.method === 'POST' && url.pathname === '/api/kiyas') {
    const b = await body(req);
    const workdir = (b.workdir || '').trim();
    if (!workdir || !fs.existsSync(workdir)) return json(res, 400, { error: 'Klasör bulunamadı: ' + workdir });
    kiyas = { baslik: b.baslik || 'Tek başına Claude', workdir };
    saveKiyas();
    claudeCalistir(kiyas, b.istem, workdir, { kaydet: saveKiyas, son: saveKiyas });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/iptal') {
    const b = await body(req);
    const t = tasks.find((x) => x.id === b.id);
    if (!t) return json(res, 404, { error: 'yok' });
    if (t.status === 'bekliyor') t.status = 'iptal';
    const r = t.agentId && running.get(t.agentId);
    if (t.status === 'calisiyor' && r && r.task === t) { t.status = 'iptal'; r.child.kill(); }
    save();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/sil') {
    const b = await body(req);
    tasks = tasks.filter((x) => !(x.id === b.id && x.status !== 'calisiyor'));
    save();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/ac') {
    const b = await body(req);
    const t = tasks.find((x) => x.id === b.id);
    const target = t ? (b.which === 'sonuc' && t.resultFile ? t.resultFile : t.workdir) : RESULTS_DIR;
    if (fs.existsSync(target)) spawn('explorer.exe', [b.which === 'sonuc' ? '/select,' + target : target], { detached: true });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/kota-sifirla') {
    for (const id in agentState) agentState[id] = { cooldownUntil: 0, note: '' };
    schedule();
    return json(res, 200, { ok: true });
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Agent İşleri paneli: http://127.0.0.1:${PORT}  ·  Ajan Odası: http://127.0.0.1:${PORT}/oda`);
  schedule();
});
