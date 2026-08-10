// GEO 通用行业内容平台 — 单文件网关 (Node 22+, 零依赖)
// 流水线: 痛点采集 → 聚类/关键词地图 → 选题评分 → 事实母稿 → 三道审核 → 平台适配 → 定时发布(幂等) → 回读
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = Number(process.env.GEO_PORT || 8030);
const BIND = process.env.GEO_BIND || '127.0.0.1'; // 公网部署用 GEO_BIND=0.0.0.0
const IS_WIN = process.platform === 'win32';

// ---------- 配置 ----------
const DEFAULT_CFG = {
  apiKey: process.env.GEO_API_KEY || '',
  baseUrl: process.env.GEO_BASE_URL || 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
  model: process.env.GEO_MODEL || 'qwen3.8-max',
  cdpPort: 3310,
  browserProfile: 'C:\\Users\\LENOVO\\Codex\\灰灰宇宙-GEO浏览器',
  edgePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  cron: '0 9 * * *',
  enabledPlatforms: ['zhihu', 'baijiahao', 'csdn'],
};
const cfg = loadJSON('config.json', DEFAULT_CFG);

function loadJSON(name, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    return { ...fallback, ...parsed };
  }
  catch { return fallback; }
}
function saveJSON(name, obj) { fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj, null, 2), 'utf8'); }
saveJSON('config.json', cfg);

// ---------- LLM 客户端 (OpenAI 兼容 / compatible-mode) ----------
// 注意: 网关按 TLS 指纹拦截 node 原生请求(401 Invalid API-key), 必须走 curl.exe
// body 通过临时文件传递(-d @file), 避免 Windows 命令行引号破坏 JSON
// 异步 spawn: 不阻塞主线程, LLM 调用期间界面仍可响应
const execFileAsync = (cmd, args, opts) => new Promise((resolve, reject) =>
  execFile(cmd, args, opts, (err, stdout, stderr) => err ? reject(err) : resolve(stdout)));

async function curlJson(url, apiKey, bodyObj) {
  const tmp = path.join(DATA_DIR, '_llm_req_' + Date.now() + '.json');
  const respFile = path.join(DATA_DIR, '_llm_resp_' + Date.now() + '.json');
  fs.writeFileSync(tmp, JSON.stringify(bodyObj), 'utf8');
  try {
    // 响应写文件: curl 超时(非零退出)时仍能读回已收到的部分, 便于诊断
    const r = await execFileAsync(IS_WIN ? 'curl.exe' : 'curl', [
      '-s', '-m', '300', '-o', respFile, '-w', '%{http_code}',
      '-X', 'POST', url,
      '-H', 'Authorization: *** ' + apiKey,
      '-H', 'content-type: application/json',
      '-d', '@' + tmp,
    ], { encoding: 'utf8' }).catch(e => e && e.message || 'curl 失败');
    const status = parseInt(String(r).trim()) || 0;
    let text = '';
    try { text = fs.readFileSync(respFile, 'utf8'); } catch {}
    return { status, text };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(respFile); } catch {}
  }
}
async function llm(prompt, system, maxTokens = 8000) {
  let tokens = maxTokens;
  for (let attempt = 0; attempt < 3; attempt++) {
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ];
    const { status, text } = await curlJson(cfg.baseUrl + '/chat/completions', cfg.apiKey, { model: cfg.model, max_tokens: tokens, messages });
    // 超时/连接失败(status 0): 等待后重试, 不立即报错
    if (status === 0) {
      if (attempt < 2) { console.warn('LLM 请求超时/失败, 10秒后重试 (' + (attempt + 1) + '/3)'); await new Promise(r => setTimeout(r, 10000)); continue; }
      throw new Error('LLM 请求超时(300s), 已重试3次: ' + text.slice(0, 150));
    }
    if (status !== 200) throw new Error('LLM HTTP ' + status + ': ' + text.slice(0, 200));
    let data; try { data = JSON.parse(text); } catch { throw new Error('LLM 返回非JSON: ' + text.slice(0, 150)); }
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const finish = data.choices && data.choices[0] && data.choices[0].finish_reason;
    // 思考模型: reasoning 吃光预算 → 正文为空且 finish_reason=length → 加倍重试
    if (!content.trim() && finish === 'length') {
      console.warn('LLM 输出被思考占满, 预算加倍重试:', tokens, '→', tokens * 2);
      tokens *= 2; continue;
    }
    return content;
  }
  throw new Error('LLM 三次尝试均无正文输出');
}
function parseJsonBlock(text) {
  const t = text.replace(/```json|```/g, '').trim();
  const s = t.indexOf('{') !== -1 && t.indexOf('[') > t.indexOf('{') ? t.indexOf('{') : t.indexOf('[');
  const start = s === -1 ? 0 : s;
  try { return JSON.parse(t.slice(start)); } catch {}
  try { return JSON.parse(t); } catch { throw new Error('LLM 返回无法解析为 JSON: ' + t.slice(0, 150)); }
}
async function llmJson(prompt, system, maxTokens = 8000) {
  return parseJsonBlock(await llm(prompt, system, maxTokens));
}

// ---------- 采集: 百度下拉词 (GBK→UTF8) ----------
async function baiduSuggest(kw) {
  const res = await fetch('https://suggestion.baidu.com/su?wd=' + encodeURIComponent(kw) + '&cb=cb', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(12000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = new TextDecoder('gbk').decode(buf);
  const m = text.match(/s:\[(.*?)\]/s);
  if (!m) return [];
  return m[1].split(',').map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
}
async function collectIndustry(industry) {
  const seeds = [industry, industry + '怎么', industry + '为什么', industry + '哪个', industry + '价格', industry + '避坑', industry + '靠谱吗'];
  const out = []; const seen = new Set();
  for (const seed of seeds) {
    try {
      const sugs = await baiduSuggest(seed);
      for (const s of sugs) {
        if (seen.has(s)) continue; seen.add(s);
        out.push({ query: s, seed, source: 'baidu_suggest', captured_at: new Date().toISOString() });
      }
    } catch (e) { /* 单种子失败不阻塞 */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return out;
}

// ---------- 平台档案 ----------
// 登录核验改为页面级：打开平台页面，看是否被踢回登录页/页面里有没有登录用户元素
// expr 返回 {login: bool, detail: string}
const PLATFORMS = {
  zhihu:     { name: '知乎',   check: { url: 'https://www.zhihu.com/', wait: 5000, expr: `(()=>{ if(location.href.includes('signin')) return {login:false,detail:'被踢回登录页'}; const el=document.querySelector('.AppHeader-userInfo,.AppHeader-profileEntry,.Popover [aria-label]'); return {login:!!el, detail: el?'首页找到已登录用户入口':'首页无用户入口(可能未登录或页面未加载完)'} })()` }, titleMax: 100, style: '结论先行+分点论证+Q&A块，专业可信，可被AI搜索引用' },
  baijiahao: { name: '百家号', check: { url: 'https://baijiahao.baidu.com/builder/rc/edit', wait: 6000, expr: `(()=>{ const u=location.href; if(u.includes('login')||u.includes('/user/')||u.includes('passport')) return {login:false,detail:'被踢回登录页'}; if(u.includes('builder')) return {login:true,detail:'进入创作后台'}; return {login:false,detail:'未知页面:'+u.slice(0,60)} })()` }, titleMax: 30, style: '科普资讯体，标题30字内，段落短，开头直接给答案' },
  csdn:      { name: 'CSDN',   check: { url: 'https://mp.csdn.net/mp_blog/manage', wait: 5000, expr: `(()=>{ const u=location.href; if(u.includes('passport')||u.includes('login')) return {login:false,detail:'被踢回登录页'}; if(u.includes('mp.csdn.net')) return {login:true,detail:'进入CSDN管理后台'}; return {login:false,detail:'未知页面'} })()` }, titleMax: 100, style: '技术干货体，步骤编号，代码/清单格式' },
  weibo:     { name: '微博',   check: { url: 'https://weibo.com/', wait: 6000, expr: `(()=>{ if(location.href.includes('passport')) return {login:false,detail:'被踢回登录页'}; const v=window.$CONFIG&&window.$CONFIG.isLogin; if(v==='1') return {login:true,detail:'$CONFIG.isLogin=1'}; const av=document.querySelector('[class*=woo-avatar],.gn_nav .gn_name'); return {login:!!av, detail: av?'找到用户头像/昵称':'未找到登录痕迹'} })()` }, titleMax: 0, style: '口语化短文，带话题#标签#，1000字内', maxLen: 1000 },
  bilibili:  { name: 'B站专栏', check: { url: 'https://www.bilibili.com/', wait: 4000, expr: `fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}).then(r=>r.json()).then(d=>({login:!!(d.data&&d.data.isLogin),detail:(d.data&&d.data.isLogin)?('已登录: '+d.data.uname):(d.message||'未登录')})).catch(e=>({login:false,detail:'nav接口异常:'+String(e).slice(0,40)}))` }, titleMax: 40, style: '年轻向科普，轻松但信息密度高' },
  toutiao:   { name: '头条号', check: { url: 'https://mp.toutiao.com/profile_page/index', wait: 6000, expr: `(()=>{ const u=location.href; if(u.includes('sso.toutiao.com')||u.includes('login')) return {login:false,detail:'被踢回登录页'}; if(u.includes('mp.toutiao.com')) return {login:true,detail:'进入头条号后台'}; return {login:false,detail:'未知页面'} })()` }, titleMax: 30, style: '大众资讯体，强钩子开头' },
};

// ---------- 任务系统 (异步流水线) ----------
const jobs = new Map();
let jobSeq = 1;
function newJob(name) {
  const id = 'job' + (jobSeq++);
  jobs.set(id, { id, name, status: 'running', progress: [], started_at: new Date().toISOString() });
  return jobs.get(id);
}
function jlog(job, step, detail) {
  job.progress.push({ t: new Date().toISOString(), step, detail });
  console.log(`[${job.id}] ${step}: ${detail}`);
}
function finish(job, result) { job.status = 'done'; job.result = result; job.finished_at = new Date().toISOString(); }
function fail(job, err) { job.status = 'error'; job.error = String(err && err.message || err); job.finished_at = new Date().toISOString(); }

// ---------- 流水线核心 ----------
async function runCluster(ind) {
  const pains = loadJSON('painpoints.json', []);
  const mine = pains.filter(p => p.industry === ind.industry);
  if (!mine.length) throw new Error('先运行痛点采集');
  const sys = '你是GEO内容策略专家。严格输出JSON，不要任何解释文字。';
  const prompt = `行业：${ind.industry}\n以下是采集到的真实用户搜索问题（来源：百度下拉词）：\n${mine.slice(0, 120).map(p => '- ' + p.query).join('\n')}\n\n任务：\n1. 把这些问题聚类为痛点簇(最多8个)，每簇给出：who(谁)、scenario(场景)、blocker(阻碍)、desired(期望结果)、examples(3个原话)、count\n2. 生成五层关键词地图：shorttail(短尾类别词3个)、longtail(问题长尾词8个)、modifier(场景修饰词5个)、capability(能力方案词5个)、brand_note\n输出JSON：{"clusters":[...],"keyword_map":{...}}`;
  const r = await llmJson(prompt, sys);
  ind.clusters = r.clusters || []; ind.keyword_map = r.keyword_map || {};
  ind.updated_at = new Date().toISOString();
  saveIndustry(ind);
  return r;
}

async function runProposals(ind) {
  if (!ind.clusters || !ind.clusters.length) throw new Error('先运行痛点聚类');
  const sys = '你是GEO选题编辑。严格输出JSON数组，不要解释。';
  const prompt = `行业：${ind.industry}\n痛点簇：\n${JSON.stringify(ind.clusters, null, 1)}\n关键词地图：${JSON.stringify(ind.keyword_map)}\n\n为每个最有价值的痛点簇生成选题提案，按25分制评分（需求频率/痛苦强度/商业意图/内容缺口/事实合规，各0-5分）。每个提案字段：topic,audience,stage(认知|比较|购买|使用|复购),pain_point(一句话),primary_intent,primary_longtail,shorttail,angle(独特角度),outline(5段结构数组),cta,scores{frequency,pain,intent,gap,evidence},total。按total降序，最多6个。输出JSON数组。`;
  const arr = await llmJson(prompt, sys);
  const topics = loadJSON('topics.json', []);
  for (const t of arr) {
    t.id = 'T' + Date.now().toString(36) + Math.floor(Math.random() * 999);
    t.industry = ind.industry; t.status = 'proposed'; t.created_at = new Date().toISOString();
    topics.push(t);
  }
  saveJSON('topics.json', topics);
  return arr;
}

// ---------- 内容质量规范 (浓缩自 dontbesilent dbs-ai-check 22条AI指纹 + dbs-hook 开头公式) ----------
const ANTI_AI = `去AI味硬约束(违反即失败)：
- 禁止匀速排比：有并列就打破均匀，长短句交错，混入3-8字短句
- 连接词克制：「然而/事实上/值得注意的是/不仅…而且/首先…其次…最后」全文不超过2处
- 无翻译腔：少用「作为/关于/对于/基于/进行/赋能/助力」，嘴上怎么说就怎么写
- 「不是X，而是Y」全文最多1次；禁止「本质上/归根结底」升维
- 不是每段都要收束金句；结尾内容说完就停，不加「你值得/愿…」式祝福
- 数字必须真实，编不出的写「待确认」；不编造「我一个朋友」式虚假案例
- 同一个词准就重复用，不刻意换同义词；不堆砌术语`;
const HOOK = `看点要求(开头5秒独立成立)：
- 开头50-100字 = 讲什么 + 为什么值得看 + 为什么可信，直接陈述不绕弯
- 制造悬念不直接给完整答案；禁止自问自答式反问开头
- 标题用认知冲突/好奇缺口/避坑损失之一，像人说话，不当标题党`;

async function runDraft(topic) {
  const ind = getIndustry(topic.industry);
  const sys = '你是行业内容作者，写可被AI搜索引用的事实型文章。写出来的东西要像一个干了十年的从业者亲口说的，不像AI生成的。严格输出JSON。';
  const prompt = `行业：${topic.industry}\n选题：${topic.topic}\n痛点：${topic.pain_point}\n人群：${topic.audience}\n主长尾词：${topic.primary_longtail}\n结构：${JSON.stringify(topic.outline)}\n角度：${topic.angle}\n\n写母稿，结构必须是：1)开头50-100字直接回答 2)用户场景 3)判断依据 4)解释和例子 5)差异条件 6)可执行步骤 7)边界声明 8)CTA(${topic.cta})。\n要求：结论先行、自然出现主长尾词1次和短尾词2次、不夸大不承诺、无法确定的写"待确认"。\n${ANTI_AI}\n${HOOK}\n输出JSON：{"title":"","summary":"80字摘要","body_md":"完整markdown正文","qa":[{"q":"","a":""}...(3个可被AI引用的问答)]}`;
  const r = await llmJson(prompt, sys, 12000);
  const articles = loadJSON('articles.json', []);
  const art = { id: 'A' + Date.now().toString(36), topic_id: topic.id, industry: topic.industry, ...r, status: 'drafted', created_at: new Date().toISOString(), reviews: null, versions: {} };
  articles.push(art); saveJSON('articles.json', articles);
  topic.status = 'drafted';
  const allTopics = loadJSON('topics.json', []);
  const ti = allTopics.findIndex(t => t.id === topic.id);
  if (ti >= 0) { allTopics[ti] = topic; saveTopics(allTopics); }
  return art;
}

async function runReview(art) {
  const sys = '你是内容审核员，三道闸：合规、事实溯源、调性。严格输出JSON。';
  const prompt = `审核以下文章：\n标题：${art.title}\n摘要：${art.summary}\n正文：\n${art.body_md}\n\n三道闸：\n1.compliance：敏感词/违规表述/绝对化承诺/医疗金融法律风险，列出问题\n2.facts：是否存在无法溯源的杜撰数据或断言，列出可疑句\n3.tone：是否像广告而非解答问题，0-10分\n每项给 pass(bool)+issues[]。verdict=三闸全过才pass。输出JSON：{"compliance":{"pass":true,"issues":[]},"facts":{...},"tone":{"pass":true,"score":8,"issues":[]},"verdict":true,"advice":""}`;
  const r = await llmJson(prompt, sys, 6000);
  art.reviews = { ...r, at: new Date().toISOString() };
  if (r.verdict) art.status = 'reviewed';
  saveArticles(loadJSON('articles.json', []).map(a => a.id === art.id ? art : a));
  return r;
}

async function runAdapt(art) {
  const enabled = cfg.enabledPlatforms.filter(p => PLATFORMS[p]);
  for (const pid of enabled) {
    const P = PLATFORMS[pid];
    const prompt = `把母稿适配到「${P.name}」平台。平台风格：${P.style}。标题上限${P.titleMax || 60}字${P.maxLen ? '，正文上限' + P.maxLen + '字' : ''}。\n母稿标题：${art.title}\n摘要：${art.summary}\n正文：\n${art.body_md}\n\n要求：不是复制粘贴，按平台风格重写结构；保留事实；${pid === 'zhihu' ? '强化可被AI引用结构(结论先行+Q&A)' : '强化该平台的阅读体验'}。\n${ANTI_AI}\n${HOOK}\n严格输出JSON：{"title":"","body_md":""}`;
    try {
      const v = await llmJson(prompt, '你是多平台内容适配专家。写出来的东西像该平台上的真人作者，不像AI。严格输出JSON。', 8000);
      art.versions[pid] = { ...v, at: new Date().toISOString(), status: 'ready' };
    } catch (e) {
      art.versions[pid] = { status: 'error', error: String(e.message || e) };
    }
  }
  art.status = 'adapted';
  saveArticles(loadJSON('articles.json', []).map(a => a.id === art.id ? art : a));
  return art.versions;
}

// ---------- 去AI味 (dbs-ai-check 检测 + 改写) ----------
async function runHumanize(art) {
  const sys = '你是文字质检编辑，精通识别AI写作痕迹。检测时像质检员一样逐条引用原文，改写时像一个干了十年的从业者亲口说话。严格输出JSON。';
  // 第一遍: 检测AI指纹 (22条特征浓缩)
  const checkPrompt = `检测以下文章的AI写作指纹，逐处引用原文并给严重度(高/中/低)。检测清单：
1匀速排比 2连接词过密(然而/事实上/值得注意的是) 3翻译腔(作为/关于/基于/进行) 4「不是X而是Y」过密 5「本质上/归根结底」升维 6段段收束金句 7情绪曲线过于光滑无犹豫 8编造「我一个朋友」案例 9结尾「你值得/愿」式祝福 10同义词刻意替换 11开头钩子+痛点+承诺三件套 12精确到不真实的数字 13句长过于均匀 14堵住所有反驳 15知识全部输出堆砌
${art.body_md}

输出JSON：{"hits":[{"quote":"原文引用","feature":"特征名","severity":"高|中|低"}],"ai_score":0-100的AI味总分,"clean":bool}`;
  const report = await llmJson(checkPrompt, sys, 6000);
  const before = (report.ai_score ?? 0);
  // 干净或只有轻微问题则不改写
  if (report.clean || before <= 20) {
    art.humanize = { ...report, at: new Date().toISOString(), rewritten: false, note: before <= 20 ? 'AI味已很低，无需改写' : '判定干净' };
    saveArticles(loadJSON('articles.json', []).map(a => a.id === art.id ? art : a));
    return art.humanize;
  }
  // 第二遍: 针对命中项改写 (保事实、保结构、保关键词)
  const hitList = (report.hits || []).map(h => `- [${h.severity}] ${h.feature}: "${(h.quote || '').slice(0, 60)}"`).join('\n');
  const rewritePrompt = `以下是文章和它的AI指纹检测报告。请改写消除这些AI味，规则：
1. 所有事实、数字、结论、步骤、Q&A原样保留，不得增删事实
2. 保留主长尾词和短尾词的出现
3. 针对命中项逐处改写：排比打破均匀、连接词删掉一半、翻译腔换成口语、「不是X而是Y」只留最有力的一处、删掉多余金句和祝福式结尾
4. 加入真人感：偶尔的口语短句、一处坦承不确定、具体场景细节
5. 结构和小标题可以微调但信息点不丢

命中的AI指纹：
${hitList}

原文：
${art.body_md}

输出JSON：{"body_md":"改写后的完整markdown正文","changes":["改动说明1","..."]}`;
  const rw = await llmJson(rewritePrompt, sys, 12000);
  if (!rw.body_md || rw.body_md.length < art.body_md.length * 0.5) throw new Error('改写结果异常（过短或为空），保留原稿');
  // 复检 (用改写后的正文)
  const recheckPrompt = checkPrompt.replace(art.body_md, rw.body_md);
  const recheck = await llmJson(recheckPrompt, sys, 6000);
  art.body_md = rw.body_md;
  art.humanize = { report, score_before: before, score_after: recheck.ai_score ?? null, changes: rw.changes || [], at: new Date().toISOString(), rewritten: true };
  saveArticles(loadJSON('articles.json', []).map(a => a.id === art.id ? art : a));
  return art.humanize;
}

// ---------- 全流程 ----------
async function pipeline(industryName) {
  const job = newJob('全流程: ' + industryName);
  (async () => {
    try {
      let ind = getIndustry(industryName);
      if (!ind) { ind = { industry: industryName, created_at: new Date().toISOString() }; saveIndustry(ind); }
      jlog(job, '采集', '百度下拉词采集中…');
      const raw = await collectIndustry(industryName);
      const pains = loadJSON('painpoints.json', []);
      let added = 0;
      for (const r of raw) {
        if (!pains.some(p => p.query === r.query && p.industry === industryName)) { pains.push({ ...r, industry: industryName }); added++; }
      }
      saveJSON('painpoints.json', pains);
      jlog(job, '采集', `完成，新增 ${added} 条真实问题`);

      jlog(job, '聚类', 'LLM 痛点聚类 + 关键词地图…');
      const cl = await runCluster(ind);
      jlog(job, '聚类', `得到 ${(cl.clusters || []).length} 个痛点簇`);

      jlog(job, '选题', '生成选题提案并评分…');
      const props = await runProposals(ind);
      jlog(job, '选题', `生成 ${props.length} 个提案，最高分 ${props[0]?.total}`);

      const topics = loadJSON('topics.json', []);
      const top = props.sort((a, b) => (b.total || 0) - (a.total || 0))[0];
      const topicRec = topics.find(t => t.topic === top.topic && t.industry === industryName);
      topicRec.status = 'approved'; saveTopics(topics);

      jlog(job, '母稿', `撰写《${top.topic}》…`);
      const art = await runDraft(topicRec);
      jlog(job, '母稿', '完成，去AI味');

      jlog(job, '去AI味', '检测AI指纹并改写…');
      const hm = await runHumanize(art);
      jlog(job, '去AI味', hm.rewritten ? `AI味 ${hm.score_before}→${hm.score_after}` : 'AI味已低，跳过改写');

      jlog(job, '审核', '合规/事实/调性 三闸审核…');
      const rv = await runReview(art);
      jlog(job, '审核', rv.verdict ? '✅ 三闸全过' : '⚠️ 有问题: ' + rv.advice);

      jlog(job, '适配', `生成 ${cfg.enabledPlatforms.length} 个平台版本…`);
      await runAdapt(art);
      jlog(job, '适配', '完成');

      // 进发布队列
      const queue = loadJSON('publish-queue.json', []);
      queue.push({ id: 'Q' + Date.now().toString(36), article_id: art.id, topic_id: topicRec.id, industry: industryName, platforms: [...cfg.enabledPlatforms], status: 'queued', created_at: new Date().toISOString() });
      saveJSON('publish-queue.json', queue);

      finish(job, { article_id: art.id, topic: top.topic, review: rv.verdict, queue: queue.length });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

// ---------- 数据 CRUD ----------
function industries() { return loadJSON('industries.json', []); }
function getIndustry(name) { return industries().find(i => i.industry === name); }
function saveIndustry(ind) {
  const list = industries(); const i = list.findIndex(x => x.industry === ind.industry);
  if (i >= 0) list[i] = ind; else list.push(ind);
  saveJSON('industries.json', list);
}
function saveTopics(t) { saveJSON('topics.json', t); }
function saveArticles(a) { saveJSON('articles.json', a); }

// ---------- 定时发布 (幂等) ----------
function cronMatch(spec, d) {
  const parts = spec.trim().split(/\s+/); if (parts.length !== 5) return false;
  const fields = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  return parts.every((p, i) => p === '*' || p.split(',').some(v => {
    if (v.includes('/')) { const [a, b] = v.split('/'); return fields[i] % Number(b) === Number(a === '*' ? 0 : a); }
    if (v.includes('-')) { const [a, b] = v.split('-').map(Number); return fields[i] >= a && fields[i] <= b; }
    return Number(v) === fields[i];
  }));
}
const dateLock = { date: '', running: false };
async function dailyRun() {
  const today = new Date().toISOString().slice(0, 10);
  if (dateLock.date === today || dateLock.running) return { skipped: true };
  dateLock.date = today; dateLock.running = true;
  try {
    const ind = industries()[0]; if (!ind) return { skipped: 'no industry' };
    const topics = loadJSON('topics.json', []).filter(t => t.status === 'proposed').sort((a, b) => (b.total || 0) - (a.total || 0));
    const t = topics[0];
    if (!t) { const job = await pipeline(ind.industry); return { job: job.id }; }
    t.status = 'approved';
    const all = loadJSON('topics.json', []);
    const idx = all.findIndex(x => x.id === t.id); if (idx >= 0) { all[idx] = t; saveTopics(all); }
    const art = await runDraft(t); await runReview(art); await runAdapt(art);
    const queue = loadJSON('publish-queue.json', []);
    queue.push({ id: 'Q' + Date.now().toString(36), article_id: art.id, topic_id: t.id, industry: ind.industry, platforms: [...cfg.enabledPlatforms], status: 'queued', created_at: new Date().toISOString() });
    saveJSON('publish-queue.json', queue);
    return { article_id: art.id };
  } finally { dateLock.running = false; }
}
setInterval(() => { try { if (cronMatch(cfg.cron, new Date())) dailyRun(); } catch (e) { console.error('cron err', e); } }, 30000);

// ---------- 幂等键 ----------
function idemKey(brand, proposalId, platformId) {
  return [brand, new Date().toISOString().slice(0, 10), proposalId, platformId].join('::');
}
function publishLog() { return loadJSON('publish-log.json', []); }

// ---------- CDP 浏览器控制 ----------
async function cdpJson(p) {
  const res = await fetch(`http://127.0.0.1:${cfg.cdpPort}${p}`, { signal: AbortSignal.timeout(4000) });
  return res.json();
}
async function browserUp() { try { await cdpJson('/json/version'); return true; } catch { return false; } }
async function launchBrowser() {
  if (await browserUp()) return { already: true };
  const { spawn } = await import('child_process');
  const child = spawn(cfg.edgePath, [
    `--user-data-dir=${cfg.browserProfile}`, `--remote-debugging-port=${cfg.cdpPort}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 1000)); if (await browserUp()) return { launched: true }; }
  throw new Error('浏览器 30 秒内未就绪');
}
async function cdpNewTab(url) {
  const res = await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  return res.json();
}
function wsEval(wsUrl, expr, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP evaluate 超时')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        clearTimeout(timer); ws.close();
        if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails.exception || msg.result.exceptionDetails).slice(0, 200)));
        else resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}
async function probePlatform(pid) {
  const P = PLATFORMS[pid]; if (!P.check) return { platform: pid, name: P.name, login: null, note: '无核验配置' };
  let tab;
  try { tab = await cdpNewTab(P.check.url); } catch (e) { return { platform: pid, name: P.name, login: false, error: '开标签失败: ' + String(e.message || e) }; }
  try {
    await new Promise(r => setTimeout(r, P.check.wait || 5000));
    // 页面可能还在SSO跳转链中，多等一轮重定向
    await new Promise(r => setTimeout(r, 2000));
    const res = await wsEval(tab.webSocketDebuggerUrl, `(async()=>{ return await (${P.check.expr}); })()`, 15000);
    if (res && typeof res.login === 'boolean') return { platform: pid, name: P.name, login: res.login, detail: res.detail || '' };
    return { platform: pid, name: P.name, login: false, detail: '核验表达式无返回: ' + JSON.stringify(res).slice(0, 80) };
  } catch (e) {
    return { platform: pid, name: P.name, login: false, error: String(e.message || e) };
  } finally {
    try { await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${tab.id}`, { signal: AbortSignal.timeout(3000) }); } catch {}
  }
}
async function checkLogins() {
  if (!(await browserUp())) throw new Error('浏览器未启动，先调 /api/browser/launch');
  const out = [];
  for (const pid of Object.keys(PLATFORMS)) { out.push(await probePlatform(pid)); }
  saveJSON('logins.json', { at: new Date().toISOString(), results: out });
  return out;
}

// ---------- 真实发布引擎 (CDP驱动) ----------
function cdpcmd(wsUrl, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(method + ' 超时')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        clearTimeout(timer); ws.close();
        if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error).slice(0, 150)));
        else resolve(msg.result);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(method + ' ws error')); };
  });
}
async function openTabAndWait(url, waitMs = 6000) {
  const tab = await cdpNewTab(url);
  await new Promise(r => setTimeout(r, waitMs));
  return tab;
}
async function tabUrl(wsUrl) {
  const r = await wsEval(wsUrl, 'location.href', 5000);
  return String(r || '');
}
async function typeInto(wsUrl, selector, text, waitAfter = 800) {
  // 点击聚焦 + 清空 + 逐段插入
  await wsEval(wsUrl, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el){el.focus();el.click();}return !!el})()`, 8000);
  await cdpcmd(wsUrl, 'Input.insertText', { text: '' });
  await cdpcmd(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
  await cdpcmd(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
  await cdpcmd(wsUrl, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete' });
  await cdpcmd(wsUrl, 'Input.insertText', { text });
  await new Promise(r => setTimeout(r, waitAfter));
}
async function clickSelector(wsUrl, selector) {
  return wsEval(wsUrl, `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(selector)})];const el=els.find(e=>e.offsetParent!==null)||els[0];if(!el)return false;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, 8000);
}
async function realClick(wsUrl, pt) {
  if (!pt) return false;
  await cdpcmd(wsUrl, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await cdpcmd(wsUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 120));
  await cdpcmd(wsUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  return true;
}
async function clickByText(wsUrl, tagSel, text) {
  const pt = await wsEval(wsUrl, `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(tagSel)})];const el=els.find(e=>e.textContent.trim().includes(${JSON.stringify(text)})&&e.offsetParent!==null);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, 8000);
  if (!pt) return false;
  return realClick(wsUrl, pt);
}

// md → 平台正文 (知乎/头条支持富文本的直接插HTML；其余插纯文本分段)
function mdToHtml(md) {
  return md
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^- (.*)$/gm, '<p>• $1</p>')
    .split(/\n{2,}/).map(b => /^<(h\d|p)/.test(b.trim()) ? b : '<p>' + b.replace(/\n/g, '<br>') + '</p>').join('');
}
function mdToText(md) {
  return md.replace(/^#{1,3} /gm, '').replace(/\*\*/g, '').replace(/^- /gm, '• ');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 粘贴注入：构造 ClipboardEvent('paste')，兼容 Draft.js/ProseMirror/Quill/contenteditable 富文本编辑器
// （Input.insertText 会破坏 Draft.js 等编辑器的内部状态，导致发布按钮卡死——知乎实测教训）
async function pasteInto(wsUrl, focusExpr, html, plain) {
  const focused = await wsEval(wsUrl, focusExpr, 8000);
  if (!focused) return false;
  await sleep(500);
  const r = await wsEval(wsUrl, `((html, plain) => {
    const target = (document.activeElement && document.activeElement.isContentEditable) ? document.activeElement : document.querySelector('[contenteditable="true"]');
    if (!target) return 'no_editable';
    const dt = new DataTransfer();
    if (html) dt.setData('text/html', html);
    dt.setData('text/plain', plain);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'dispatched';
  })(${JSON.stringify(html || '')}, ${JSON.stringify(plain || '')})`, 20000).catch(() => 'err');
  return r === 'dispatched';
}
// 轮询等待正文长度达标（编辑器渲染需要时间）
async function waitForBody(wsUrl, lenExpr, minLen, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const len = Number(await wsEval(wsUrl, lenExpr, 6000).catch(() => 0)) || 0;
    if (len >= minLen) return len;
    await sleep(1500);
  }
  return 0;
}
// 连点发布后轮询URL跳转判定落地
async function waitForUrl(wsUrl, re, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const u = await tabUrl(wsUrl);
    if (re.test(u)) return u;
    await sleep(1500);
  }
  return null;
}

async function publishZhihu(title, body) {
  const tab = await openTabAndWait('https://zhuanlan.zhihu.com/write', 8000);
  const ws = tab.webSocketDebuggerUrl;
  try {
    const u = await tabUrl(ws);
    if (u.includes('signin') || u.includes('login')) throw new Error('知乎未登录/被踢回登录页');
    if ((await wsEval(ws, 'document.body.innerText', 5000) || '').includes('安全验证')) throw new Error('知乎触发安全验证(滑块)，需在浏览器手动过一次');
    // 标题
    await typeInto(ws, 'textarea', title);
    // 正文：粘贴注入原始 Markdown（知乎编辑器会自动提示解析）
    const okPaste = await pasteInto(ws, `(()=>{const el=document.querySelector('.public-DraftEditor-content');if(el){el.focus();el.click();return true}return false})()`, '', body);
    if (!okPaste) throw new Error('知乎编辑器聚焦失败');
    const len = await waitForBody(ws, `((document.querySelector('.public-DraftEditor-content')||{}).innerText||'').length`, 100, 15000);
    if (len < 100) throw new Error('知乎正文注入失败(长度' + len + ')');
    await sleep(1500);
    // 知乎检测到 Markdown 会弹"确认并解析"提示条
    await clickByText(ws, 'button,a,span,div', '确认并解析').catch(() => {});
    await sleep(3000);
    // 点发布 → 发布设置面板 → 确认发布
    await clickByText(ws, 'button', '发布');
    await sleep(4000);
    await clickByText(ws, 'button', '确认发布').catch(() => {});
    const landed = await waitForUrl(ws, /zhuanlan\.zhihu\.com\/p\/\d+(?!.*\/edit)/, 30000);
    if (landed) return { ok: true, url: landed, detail: '发布成功' };
    // 未跳转：查草稿状态区分风控/审核
    const state = await wsEval(ws, `(async()=>{try{const m=location.href.match(/\\/p\\/(\\d+)/);if(!m)return 'no_id';const r=await fetch('/api/articles/'+m[1]+'/draft',{credentials:'include'});const j=await r.json();return j.state||'unknown'}catch(e){return 'err'}})()`, 15000).catch(() => 'n/a');
    return { ok: null, url: await tabUrl(ws), detail: '点发布后未跳文章页(草稿状态=' + state + ')，可能风控限制/发布确认弹窗/审核中，需人工确认' };
  } finally { try { await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${tab.id}`); } catch {} }
}

async function publishToutiao(title, body) {
  const tab = await openTabAndWait('https://mp.toutiao.com/profile_graphical/publish-article', 9000);
  const ws = tab.webSocketDebuggerUrl;
  try {
    const u = await tabUrl(ws);
    if (u.includes('sso.toutiao.com') || u.includes('login')) throw new Error('头条号未登录/被踢回登录页');
    // 标题输入
    await typeInto(ws, 'textarea[placeholder*="标题"],input[placeholder*="标题"],.articlecard-title textarea,textarea', title);
    // 正文：粘贴注入 (ProseMirror/contenteditable)
    const okPaste = await pasteInto(ws, `(()=>{const el=document.querySelector('.ProseMirror,[contenteditable="true"]');if(el){el.focus();el.click();return true}return false})()`, mdToHtml(body), mdToText(body));
    if (!okPaste) throw new Error('头条编辑器聚焦失败');
    const len = await waitForBody(ws, `((document.querySelector('.ProseMirror,[contenteditable="true"]')||{}).innerText||'').length`, 100, 15000);
    if (len < 100) throw new Error('头条正文注入失败(长度' + len + ')');
    await sleep(1500);
    // 发布按钮
    await clickByText(ws, 'button,div[role=button]', '发布');
    await sleep(4000);
    // 可能的确认弹窗
    await clickByText(ws, 'button', '确认发布').catch(() => {});
    await clickByText(ws, 'button', '仍然发布').catch(() => {});
    const finalUrl = await tabUrl(ws);
    const bodyText = await wsEval(ws, 'document.body.innerText.slice(0,400)', 6000).catch(() => '');
    const success = String(bodyText).includes('发布成功') || /content-manage|article-manage/.test(finalUrl);
    return { ok: success || null, url: finalUrl, detail: success ? '发布成功(头条有审核流程)' : '已提交，需到内容管理页人工确认(头条发布后进入审核)' };
  } finally { try { await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${tab.id}`); } catch {} }
}

async function publishWeibo(body, title) {
  const tab = await openTabAndWait('https://weibo.com/', 8000);
  const ws = tab.webSocketDebuggerUrl;
  try {
    const u = await tabUrl(ws);
    if (u.includes('newlogin') || u.includes('passport')) throw new Error('微博未登录/被踢回登录页');
    // 微博正文上限1000字
    const text = mdToText(body).slice(0, 980);
    // 微博首页发布框是React受控textarea，必须用原生value setter + input事件注入
    const r = await wsEval(ws, `((t)=>{
      const ta=document.querySelector('textarea._input_1rz8r_8,textarea[placeholder*="新鲜事"]');
      if(!ta)return 'no_textarea';
      ta.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(ta,t);
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      ta.dispatchEvent(new Event('change',{bubbles:true}));
      return 'ok:'+ta.value.length;
    })(${JSON.stringify(text)})`, 10000);
    if (!String(r).startsWith('ok:')) throw new Error('微博发布框注入失败: ' + r);
    await sleep(1500);
    // 发送按钮(注入后才激活)
    const clicked = await clickByText(ws, 'button,a,[role=button]', '发送') || await clickByText(ws, 'button,a', '发布');
    if (!clicked) throw new Error('找不到微博发送按钮');
    await sleep(4000);
    // 微博风控可能静默拦截，检查输入框是否已清空
    const still = Number(await wsEval(ws, `(()=>{const ta=document.querySelector('textarea._input_1rz8r_8,textarea[placeholder*="新鲜事"]');return ta?(ta.value||'').length:-1})()`, 5000).catch(() => -1));
    return { ok: still >= 0 && still < 10 ? true : null, url: 'https://weibo.com/', detail: still >= 0 && still < 10 ? '已发送(微博可能有静默审核，建议到主页核验)' : '发送后输入框仍有内容(' + still + '字)，可能被风控拦截，需人工确认' };
  } finally { try { await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${tab.id}`); } catch {} }
}

async function publishCsdn(title, body) {
  const tab = await openTabAndWait('https://editor.csdn.net/', 9000);
  const ws = tab.webSocketDebuggerUrl;
  try {
    const u = await tabUrl(ws);
    if (u.includes('passport') || u.includes('login')) throw new Error('CSDN未登录/被踢回登录页');
    // 标题
    await typeInto(ws, '.article-bar__title input,input[placeholder*="标题"]', title);
    // CSDN是markdown编辑器：聚焦编辑区后粘贴注入原始md
    const okPaste = await pasteInto(ws, `(()=>{const el=document.querySelector('.editor__inner .cledit-section,.editor .ace_editor,[contenteditable="true"]');if(el){el.focus();el.click();return true}return false})()`, '', body);
    if (!okPaste) throw new Error('CSDN编辑器聚焦失败');
    const len = await waitForBody(ws, `(()=>{const el=document.querySelector('.editor__inner,[contenteditable="true"],.ace_content');return el?(el.innerText||'').length:0})()`, 100, 15000);
    if (len < 100) throw new Error('CSDN正文注入失败(长度' + len + ')');
    await sleep(1500);
    // 发布按钮
    await clickByText(ws, 'button', '发布文章');
    await sleep(3000);
    // 发布面板：确认发布
    await clickByText(ws, 'button', '确认发布').catch(() => {});
    await clickByText(ws, 'button', '确认并发布').catch(() => {});
    const landed = await waitForUrl(ws, /blog\.csdn\.net\/.+\/article\/details|\/mp\/blog\/manage/, 30000);
    return { ok: !!landed, url: await tabUrl(ws), detail: landed ? '发布成功' : '需人工确认发布面板' };
  } finally { try { await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${tab.id}`); } catch {} }
}

async function publishBaijiahao(title, body) {
  const tab = await openTabAndWait('https://baijiahao.baidu.com/builder/rc/edit?type=news', 9000);
  const ws = tab.webSocketDebuggerUrl;
  try {
    const u = await tabUrl(ws);
    if (u.includes('login') || u.includes('passport')) throw new Error('百家号未登录/被踢回登录页');
    // 百家号是单一contenteditable编辑器(FeEditorApp)，标题=正文第一行h1
    // 1. 聚焦最大的contenteditable + 全选清空(防自动恢复旧草稿)
    const focused = await wsEval(ws, `(()=>{
      const eds=[...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetParent!==null);
      eds.sort((a,b)=>b.offsetWidth-a.offsetWidth);
      const el=eds[0];
      if(!el)return false;
      el.focus();el.click();
      const sel=window.getSelection();const r=document.createRange();r.selectNodeContents(el);sel.removeAllRanges();sel.addRange(r);
      return true;
    })()`, 8000);
    if (!focused) throw new Error('百家号编辑器聚焦失败');
    await cdpcmd(ws, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete' });
    await sleep(500);
    // 2. 粘贴注入：标题h1 + 正文
    const html = `<h1>${title}</h1>${mdToHtml(body)}`;
    const okPaste = await pasteInto(ws, 'true', html, title + '\n' + mdToText(body));
    if (!okPaste) throw new Error('百家号粘贴注入失败');
    const len = await waitForBody(ws, `(()=>{const eds=[...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetParent!==null);eds.sort((a,b)=>b.offsetWidth-a.offsetWidth);return ((eds[0]||{}).innerText||'').length})()`, 100, 15000);
    if (len < 100) throw new Error('百家号正文注入失败(长度' + len + ')');
    await sleep(1500);
    // 3. 点发布按钮(底部蓝色"发布")
    const clicked = await clickByText(ws, 'button', '发布');
    if (!clicked) throw new Error('找不到百家号发布按钮');
    await sleep(5000);
    // 4. 可能弹发文设置/封面确认
    await clickByText(ws, 'button', '确认发布').catch(() => {});
    await clickByText(ws, 'button', '直接发布').catch(() => {});
    await sleep(3000);
    // 5. 判定：跳内容管理页 or 页面出现发布成功
    const finalUrl = await tabUrl(ws);
    const bodyText = await wsEval(ws, 'document.body.innerText.slice(0,500)', 6000).catch(() => '');
    const success = String(bodyText).includes('发布成功') || /builderinner\/content|article-manage|publishSucc/.test(finalUrl);
    // 未跳转时检查编辑器里是否还有内容(有=被拦住了)
    if (!success) {
      const still = Number(await wsEval(ws, `(()=>{const eds=[...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetParent!==null);eds.sort((a,b)=>b.offsetWidth-a.offsetWidth);return ((eds[0]||{}).innerText||'').length})()`, 6000).catch(() => -1));
      if (still < 10) return { ok: true, url: finalUrl, detail: '内容已清空(发布已提交)，百家号有审核流程' };
      return { ok: null, url: finalUrl, detail: '提交后仍在编辑页，可能被拦(缺封面/分类/原创声明)，需人工确认', bodyText: String(bodyText).slice(0, 200) };
    }
    return { ok: true, url: finalUrl, detail: '发布成功(百家号有审核流程)' };
  } finally { try { await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${tab.id}`); } catch {} }
}

const PUBLISHERS = { zhihu: publishZhihu, toutiao: publishToutiao, weibo: publishWeibo, csdn: publishCsdn, baijiahao: publishBaijiahao };

async function realPublish(pid, art) {
  const v = art.versions[pid];
  if (!v || v.status !== 'ready') throw new Error('该平台版本未就绪');
  const P = PLATFORMS[pid];
  const fn = PUBLISHERS[pid];
  if (!fn) throw new Error(P.name + ' 发布引擎未实现(百家号需UIA路径，B站专栏待做)');
  const title = String(v.title || art.title || '').slice(0, P.titleMax || 100);
  const body = String(v.body_md || art.body_md || '');
  const r = await fn(title, body);
  // 记发布日志
  const log = publishLog();
  const key = idemKey(art.industry, art.topic_id, pid);
  const prev = log.find(l => l.idem === key);
  const entry = { idem: key, article_id: art.id, platform: pid, title, status: r.ok === true ? 'published' : (r.ok === false ? 'needs_confirm' : 'sent_unverified'), url: r.url, detail: r.detail, at: new Date().toISOString() };
  if (prev) Object.assign(prev, entry); else log.push(entry);
  saveJSON('publish-log.json', log);
  return entry;
}

// ---------- HTTP 路由 ----------
function send(res, code, obj, type = 'application/json') {
  const buf = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, model: cfg.model, apiConfigured: !!cfg.apiKey, cron: cfg.cron, platforms: cfg.enabledPlatforms, browser: await browserUp() });

    if (p === '/api/config' && req.method === 'POST') { const b = await readBody(req); Object.assign(cfg, b); saveJSON('config.json', cfg); return send(res, 200, { ok: true }); }
    if (p === '/api/config') return send(res, 200, { ...cfg, apiKey: cfg.apiKey ? cfg.apiKey.slice(0, 10) + '****' : '' });

    // 行业
    if (p === '/api/industries') return send(res, 200, industries());
    if (p === '/api/industries' && req.method === 'POST') {
      const b = await readBody(req); const name = (b.industry || '').trim();
      if (!name) return send(res, 400, { error: '行业不能为空' });
      let ind = getIndustry(name); if (!ind) { ind = { industry: name, created_at: new Date().toISOString() }; saveIndustry(ind); }
      return send(res, 200, ind);
    }

    // 流水线
    if (p === '/api/pipeline' && req.method === 'POST') {
      const b = await readBody(req); const job = await pipeline(b.industry);
      return send(res, 200, { job_id: job.id });
    }
    if (p === '/api/collect' && req.method === 'POST') {
      const b = await readBody(req); const job = newJob('采集: ' + b.industry);
      (async () => {
        try {
          const raw = await collectIndustry(b.industry);
          const pains = loadJSON('painpoints.json', []); let added = 0;
          for (const r of raw) { if (!pains.some(x => x.query === r.query && x.industry === b.industry)) { pains.push({ ...r, industry: b.industry }); added++; } }
          saveJSON('painpoints.json', pains); finish(job, { added });
        } catch (e) { fail(job, e); }
      })();
      return send(res, 200, { job_id: job.id });
    }
    if (p === '/api/cluster' && req.method === 'POST') {
      const b = await readBody(req); const ind = getIndustry(b.industry);
      if (!ind) return send(res, 400, { error: '行业不存在' });
      const job = newJob('聚类: ' + b.industry);
      (async () => { try { finish(job, await runCluster(ind)); } catch (e) { fail(job, e); } })();
      return send(res, 200, { job_id: job.id });
    }
    if (p === '/api/propose' && req.method === 'POST') {
      const b = await readBody(req); const ind = getIndustry(b.industry);
      if (!ind) return send(res, 400, { error: '行业不存在' });
      const job = newJob('选题: ' + b.industry);
      (async () => { try { finish(job, await runProposals(ind)); } catch (e) { fail(job, e); } })();
      return send(res, 200, { job_id: job.id });
    }
    if (p === '/api/jobs') return send(res, 200, [...jobs.values()].slice(-20).reverse());
    if (/^\/api\/jobs\//.test(p)) { const j = jobs.get(p.split('/')[3]); return j ? send(res, 200, j) : send(res, 404, { error: 'not found' }); }

    // 数据
    if (p === '/api/painpoints') return send(res, 200, loadJSON('painpoints.json', []));
    if (p === '/api/topics') return send(res, 200, loadJSON('topics.json', []));
    if (/^\/api\/topics\/[^/]+\/approve$/.test(p) && req.method === 'POST') {
      const id = p.split('/')[3]; const topics = loadJSON('topics.json', []);
      const t = topics.find(x => x.id === id); if (!t) return send(res, 404, { error: 'no topic' });
      t.status = t.status === 'approved' ? 'proposed' : 'approved'; saveTopics(topics);
      return send(res, 200, t);
    }
    if (p === '/api/articles') return send(res, 200, loadJSON('articles.json', []));
    if (/^\/api\/articles\/[^/]+$/.test(p)) {
      const a = loadJSON('articles.json', []).find(x => x.id === p.split('/')[3]);
      return a ? send(res, 200, a) : send(res, 404, { error: 'no article' });
    }
    if (/^\/api\/articles\/[^/]+\/draft$/.test(p) && req.method === 'POST') {
      const topics = loadJSON('topics.json', []);
      const t = topics.find(x => x.id === p.split('/')[3]); if (!t) return send(res, 404, { error: 'no topic' });
      const job = newJob('母稿: ' + t.topic);
      (async () => { try { finish(job, await runDraft(t)); } catch (e) { fail(job, e); } })();
      return send(res, 200, { job_id: job.id });
    }
    if (/^\/api\/articles\/[^/]+\/review$/.test(p) && req.method === 'POST') {
      const a = loadJSON('articles.json', []).find(x => x.id === p.split('/')[3]);
      if (!a) return send(res, 404, { error: 'no article' });
      const job = newJob('审核');
      (async () => { try { finish(job, await runReview(a)); } catch (e) { fail(job, e); } })();
      return send(res, 200, { job_id: job.id });
    }
    if (/^\/api\/articles\/[^/]+\/adapt$/.test(p) && req.method === 'POST') {
      const a = loadJSON('articles.json', []).find(x => x.id === p.split('/')[3]);
      if (!a) return send(res, 404, { error: 'no article' });
      const job = newJob('平台适配');
      (async () => { try { finish(job, await runAdapt(a)); } catch (e) { fail(job, e); } })();
      return send(res, 200, { job_id: job.id });
    }
    if (/^\/api\/articles\/[^/]+\/humanize$/.test(p) && req.method === 'POST') {
      const a = loadJSON('articles.json', []).find(x => x.id === p.split('/')[3]);
      if (!a) return send(res, 404, { error: 'no article' });
      const job = newJob('去AI味: ' + (a.title || '').slice(0, 20));
      (async () => { try { finish(job, await runHumanize(a)); } catch (e) { fail(job, e); } })();
      return send(res, 200, { job_id: job.id });
    }
    // 一键成稿: 母稿→三闸审核→全平台适配→进发布队列, 一个任务跑完
    if (/^\/api\/articles\/[^/]+\/full$/.test(p) && req.method === 'POST') {
      const topics = loadJSON('topics.json', []);
      const t = topics.find(x => x.id === p.split('/')[3]); if (!t) return send(res, 404, { error: 'no topic' });
      const job = newJob('一键成稿: ' + t.topic);
      (async () => {
        try {
          jlog(job, '母稿', `撰写《${t.topic}》…`);
          const art = await runDraft(t);
          jlog(job, '母稿', '完成，去AI味');
          jlog(job, '去AI味', '检测AI指纹并改写…');
          const hm = await runHumanize(art);
          jlog(job, '去AI味', hm.rewritten ? `AI味 ${hm.score_before}→${hm.score_after}` : 'AI味已低，跳过改写');
          jlog(job, '审核', '合规/事实/调性 三闸审核…');
          const rv = await runReview(art);
          jlog(job, '审核', rv.verdict ? '✅ 三闸全过' : '⚠️ 审核未过: ' + (rv.advice || ''));
          jlog(job, '适配', `生成 ${cfg.enabledPlatforms.length} 个平台版本…`);
          await runAdapt(art);
          jlog(job, '适配', '完成');
          const queue = loadJSON('publish-queue.json', []);
          queue.push({ id: 'Q' + Date.now().toString(36), article_id: art.id, topic_id: t.id, industry: t.industry, platforms: [...cfg.enabledPlatforms], status: 'queued', created_at: new Date().toISOString() });
          saveJSON('publish-queue.json', queue);
          finish(job, { article_id: art.id, topic: art.title, review: rv.verdict });
        } catch (e) { fail(job, e); }
      })();
      return send(res, 200, { job_id: job.id });
    }

    // 发布
    if (p === '/api/platforms') return send(res, 200, Object.entries(PLATFORMS).map(([id, v]) => ({ id, ...v, enabled: cfg.enabledPlatforms.includes(id) })));
    if (p === '/api/platforms/toggle' && req.method === 'POST') {
      const b = await readBody(req); const id = b.platform;
      if (!PLATFORMS[id]) return send(res, 400, { error: '未知平台' });
      const i = cfg.enabledPlatforms.indexOf(id);
      if (i >= 0) cfg.enabledPlatforms.splice(i, 1); else cfg.enabledPlatforms.push(id);
      saveJSON('config.json', cfg); return send(res, 200, cfg.enabledPlatforms);
    }
    if (p === '/api/browser/launch' && req.method === 'POST') return send(res, 200, await launchBrowser());
    if (p === '/api/logins') return send(res, 200, loadJSON('logins.json', null));
    if (p === '/api/logins/check' && req.method === 'POST') return send(res, 200, await checkLogins());

    if (p === '/api/publish' && req.method === 'POST') {
      const b = await readBody(req); // {article_id, platform}
      const a = loadJSON('articles.json', []).find(x => x.id === b.article_id);
      if (!a) return send(res, 404, { error: 'no article' });
      const v = a.versions[b.platform]; if (!v || v.status !== 'ready') return send(res, 400, { error: '该平台版本未就绪，先运行适配' });
      const key = idemKey(a.industry, a.topic_id, b.platform);
      const log = publishLog();
      if (log.some(l => l.idem === key && l.status === 'published')) return send(res, 200, { already_published: true, key });
      if (!(await browserUp())) return send(res, 400, { error: '浏览器未启动，先在发布矩阵点「启动GEO浏览器」' });
      try {
        const entry = await realPublish(b.platform, a);
        return send(res, 200, entry);
      } catch (e) {
        return send(res, 200, { error: String(e.message || e) });
      }
    }
    // 一键发布: 把所有已登录平台逐个真实发布
    if (p === '/api/publish-all' && req.method === 'POST') {
      const b = await readBody(req); // {article_id}
      const a = loadJSON('articles.json', []).find(x => x.id === b.article_id);
      if (!a) return send(res, 404, { error: 'no article' });
      if (!(await browserUp())) return send(res, 400, { error: '浏览器未启动' });
      const job = newJob('一键发布: ' + (a.title || '').slice(0, 20));
      (async () => {
        const results = [];
        for (const pid of Object.keys(PUBLISHERS)) {
          const v = a.versions[pid];
          if (!v || v.status !== 'ready') continue;
          const key = idemKey(a.industry, a.topic_id, pid);
          if (publishLog().some(l => l.idem === key && l.status === 'published')) { jlog(job, PLATFORMS[pid].name, '今天已发布，跳过(幂等)'); results.push({ platform: pid, skipped: true }); continue; }
          jlog(job, PLATFORMS[pid].name, '发布中…');
          try {
            const r = await realPublish(pid, a);
            jlog(job, PLATFORMS[pid].name, r.status === 'published' ? '✅ 发布成功 ' + (r.url || '') : '⚠️ ' + r.detail);
            results.push(r);
          } catch (e) {
            jlog(job, PLATFORMS[pid].name, '❌ ' + e.message);
            results.push({ platform: pid, status: 'error', detail: String(e.message || e) });
          }
          await new Promise(r => setTimeout(r, 4000)); // 平台间间隔，降风控
        }
        finish(job, results);
      })();
      return send(res, 200, { job_id: job.id });
    }
    if (p === '/api/publish-queue') return send(res, 200, loadJSON('publish-queue.json', []));
    if (p === '/api/publish-log') return send(res, 200, publishLog());

    // 定时
    if (p === '/api/schedule') return send(res, 200, { cron: cfg.cron, lastDaily: dateLock.date });
    if (p === '/api/schedule' && req.method === 'POST') { const b = await readBody(req); cfg.cron = b.cron || cfg.cron; saveJSON('config.json', cfg); return send(res, 200, { cron: cfg.cron }); }
    if (p === '/api/schedule/run' && req.method === 'POST') return send(res, 200, await dailyRun());

    // 静态
    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html');
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`GEO 工作台: http://${BIND}:${PORT}`);
  console.log('模型:', cfg.model, '| API key:', cfg.apiKey ? '已配置' : '未配置');
  console.log('定时发布:', cfg.cron, '| 平台:', cfg.enabledPlatforms.join(','));
});
