import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/yuanyue510/yuanyuepowercontext/tree/2026-competition-ecosystem/qoder/shuzheng';

function img(file) {
  const b = fs.readFileSync(path.join(ROOT, 'docs/qoder', file));
  return `data:image/png;base64,${b.toString('base64')}`;
}

const shots = [
  {
    file: '21-review-queue.png',
    title: '卡点复习队列（产品界面）',
    cap: '队列直接读 seekdb 关系表 sh_review：状态标签、错次数、原问题、资料集、覆盖率、未出现词、最近证据 docId、卡点 id、首次/最近/状态变更时间，三个按钮的可用性由服务端 allowed 决定。',
  },
  {
    file: '11-coverage-refusal.png',
    title: '未覆盖 → 拒答并落账（实测输出）',
    cap: '问「洛伦兹力的方向怎么判断」：覆盖率 0，两条判据同时成立 → answer.kind=refusal，statements 为空，只列字面最近的原文并声明不构成答案；同时写 sh_stuck 流水。',
  },
  {
    file: '15-review-state-machine.png',
    title: '状态机一次完整流转的库内前后对照',
    cap: 'npm run show:review 直查 seekdb、不走业务接口：重放同一边 409 且时间戳不推进，跨态回跳 409，回退 open 时 mastered_at 清空，并发双发只推进一次。',
  },
  {
    file: '09-import-ready.png',
    title: '导入后的就绪门槛轮询',
    cap: '第 1 次探测表行数已经 33、但向量通道可召回 0 → 不放行；第 2 次 33/33；第 3 次读数与上次相同才放行，共 467 ms。固定 sleep 短了会漏掉这个滞后。',
  },
];

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>书证 · 教材口径复习助手（seekdb + 本地 ONNX，全程无大模型）</title>
<meta name="description" content="把自己导入的教材切到句级存进 seekdb，提问时只用教材原句拼答案并逐句挂出处；讲不出就明说讲不出，并登记成卡点，之后按复习队列找回来。无云端大模型、无云端 embedding、无前端构建。">
<style>
:root{
  --bg:#f6f7f9; --card:#fff; --ink:#1c2024; --muted:#5b6570; --line:#e3e7ec;
  --accent:#0b6b5e; --accent-soft:#e6f2ef; --warn:#8a5a00; --warn-soft:#fdf4e3;
  --mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:clamp(15px,1.05vw + 13px,17px);line-height:1.75;
}
.wrap{max-width:900px;margin:0 auto;padding:clamp(16px,4vw,40px) clamp(14px,4vw,28px) 72px}
header.hero{padding:clamp(20px,5vw,40px) 0 8px}
.brand{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.brand h1{font-size:clamp(26px,5.2vw,38px);margin:0;letter-spacing:.5px}
.badge{font-size:13px;color:var(--accent);background:var(--accent-soft);border:1px solid #c8e4dd;border-radius:999px;padding:3px 11px;white-space:nowrap}
.lede{font-size:clamp(16px,2.4vw,19px);color:#2a3238;margin:14px 0 0;max-width:64ch}
.redlines{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 0;padding:0;list-style:none}
.redlines li{font-size:13px;color:var(--muted);border:1px solid var(--line);background:var(--card);border-radius:6px;padding:4px 10px}
nav.toc{margin:26px 0 0;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:10px;font-size:14px}
nav.toc b{font-weight:600;color:var(--muted);margin-right:6px}
nav.toc a{color:var(--accent);text-decoration:none;margin-right:14px;white-space:nowrap;display:inline-block}
nav.toc a:hover{text-decoration:underline}
section{margin-top:clamp(30px,6vw,46px)}
h2{font-size:clamp(19px,3vw,24px);margin:0 0 6px;padding-bottom:8px;border-bottom:2px solid var(--line)}
h2 .no{color:var(--accent);font-family:var(--mono);font-size:.8em;margin-right:8px}
h3{font-size:16px;margin:22px 0 6px}
p{margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:clamp(14px,3vw,20px);margin-top:16px}
.grid{display:grid;gap:14px;margin-top:16px}
@media (min-width:680px){.grid.three{grid-template-columns:repeat(3,1fr)}}
.pain{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:14px 16px}
.pain b{display:block;margin-bottom:4px}
.pain span{color:var(--muted);font-size:14px}
dl.how{margin:0}
dl.how>div{border-top:1px solid var(--line);padding:14px 0}
dl.how>div:first-child{border-top:0}
dt{font-weight:600}
dt .tag{font-family:var(--mono);font-size:12px;color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:1px 6px;margin-left:8px}
dd{margin:6px 0 0;color:#333b43}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f0f2f5;font-weight:600}
td.num{font-family:var(--mono);white-space:nowrap}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
pre{margin:0;padding:14px;background:#10161c;color:#dbe4ec;border-radius:8px;overflow-x:auto;font-family:var(--mono);font-size:13px;line-height:1.6}
pre code{white-space:pre}
.steps{counter-reset:s;list-style:none;padding:0;margin:16px 0 0}
.steps>li{position:relative;padding:0 0 18px 44px;margin:0}
.steps>li::before{counter-increment:s;content:counter(s);position:absolute;left:0;top:1px;width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;font-family:var(--mono);font-size:14px;display:flex;align-items:center;justify-content:center}
.steps>li::after{content:"";position:absolute;left:14px;top:34px;bottom:2px;width:1px;background:var(--line)}
.steps>li:last-child::after{display:none}
.steps h4{margin:2px 0 6px;font-size:15px}
figure{margin:18px 0 0;padding:0}
figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
figcaption{font-size:13px;color:var(--muted);margin-top:7px;line-height:1.6}
figcaption b{color:#2a3238}
blockquote{margin:12px 0;padding:12px 16px;background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;font-size:15px}
blockquote .src{display:block;margin-top:6px;font-size:13px;color:var(--muted)}
ul.limits{list-style:none;padding:0;margin:14px 0 0}
ul.limits>li{border-top:1px solid var(--line);padding:12px 0}
ul.limits>li:first-child{border-top:0}
ul.limits b{display:block}
ul.limits span{color:var(--muted);font-size:14px}
.note{background:var(--warn-soft);border:1px solid #f0dcae;border-radius:8px;padding:12px 14px;color:var(--warn);font-size:14px;margin-top:16px}
.repo{margin-top:18px;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:10px}
.repo a{color:var(--accent);word-break:break-all;text-decoration:none;font-family:var(--mono);font-size:14px}
.repo a:hover{text-decoration:underline}
footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
code.i{font-family:var(--mono);font-size:.9em;background:#eef1f4;border-radius:4px;padding:1px 5px}
</style>
</head>
<body>
<div class="wrap">

<header class="hero">
  <div class="brand">
    <h1>书证</h1>
    <span class="badge">seekdb 向量 + 全文混合检索 · 本地 ONNX 向量化 · 零云端模型调用</span>
  </div>
  <p class="lede">把自己导入的教材切到句级存进 seekdb，提问时<b>只用教材原句</b>拼答案并逐句挂出处；讲不出的就明说讲不出，并把这一处登记成卡点，之后按复习队列找回来。</p>
  <ul class="redlines">
    <li>无大模型调用</li>
    <li>无云端 embedding</li>
    <li>无前端构建（原生 ES Module）</li>
    <li>存储 / 检索 / 账本全在 seekdb 一个实例里</li>
  </ul>
</header>

<nav class="toc" aria-label="页内导航">
  <b>本页</b>
  <a href="#pain">三个痛点</a>
  <a href="#how">做法</a>
  <a href="#seekdb">与 seekdb 的三处结合</a>
  <a href="#data">实测数据</a>
  <a href="#shots">截图与原始输出</a>
  <a href="#run">三步跑起来</a>
  <a href="#limits">已知限制</a>
  <a href="#repo">仓库</a>
</nav>

<section id="pain">
  <h2><span class="no">01</span>三个痛点</h2>
  <div class="grid three">
    <div class="pain"><b>复习时找不到资料原句</b><span>只记得"课本上说过"，翻半小时找不到那一句，也无法确认自己记的是不是原文。</span></div>
    <div class="pain"><b>大模型答得顺，但口径和教材不一样</b><span>句子读起来更通顺，可措辞、条件、举例与教材不一致，复习时反而记错。</span></div>
    <div class="pain"><b>当时没读懂的概念，事后忘了卡在哪</b><span>"今天这道题没答上来"这件事没有留下任何记录，下次复习仍然从第一页开始。</span></div>
  </div>
  <p>对应三件事：句级切片 + 字符偏移定位（点引用跳原文不偏一个字）；答案只由检索回来的教材原句拼装、逐句挂出处；每一次"讲不出"都落进卡点账本并进入复习队列。</p>
</section>

<section id="how">
  <h2><span class="no">02</span>做法</h2>
  <div class="card">
    <p>导入：教材（md/txt/html）→ 小节 → 句级切片（最短 15 字，短句向上合并，保留 <code class="i">char_start / char_end</code> 与句间空白）→ 本地 ONNX 模型算 512 维单位向量 → 写进 seekdb 集合 → <b>就绪门槛</b>轮询放行。</p>
    <p>提问：问题抽查询词（先剥虚词）→ 每个词走一条全文通道、外加一条向量通道 → 融合成证据卡（带原句、出处、命中词、小节标题）→ 判定"覆盖 / 未覆盖"→ 覆盖则抽取式答案，未覆盖则拒答并落账。</p>
    <p>复习：拒答即产生一行卡点（概念、原问题、覆盖率、最近证据、错次数）→ 还没懂 / 在复习 / 已掌握三个按钮驱动状态机 → 队列按 <code class="i">错次 DESC, 最近出现 ASC</code> 排。</p>
  </div>
</section>

<section id="seekdb">
  <h2><span class="no">03</span>与 seekdb 的三处结合</h2>
  <dl class="how">
    <div>
      <dt>库内混合检索<span class="tag">collection.hybridSearch</span></dt>
      <dd>一次请求同时走 <code class="i">ngram2</code> 全文通道与 HNSW 向量通道（512 维 cosine），集合用 <code class="i">embeddingFunction: null</code> 建——向量由本项目在自己进程内算好再写入，数据库不需要任何向量化插件。多关键词问题拆成 k 条全文通道 + 1 条向量通道；因为 SDK v1.4 的 <code class="i">hybridSearch</code> 是"SET @search_parm → 读回 query_sql → 执行"，依赖连接上的会话变量，所以这些通道在本进程内<b>串行</b>发，宁可慢也不给错结果。切片集合、资料集注册表、卡点流水、复习队列都在同一个 seekdb 实例里；注册表与复习队列是关系表，用原生 SQL 读写。</dd>
    </div>
    <div>
      <dt>拒答判据<span class="tag">两条可解释规则</span></dt>
      <dd>判据①：查询词在命中句里的覆盖率 &lt; 0.34；判据②：没有任何一句同时包含 ≥2 个查询词。两条<b>同时</b>成立才拒答，拒答时 <code class="i">statements</code> 为空，只列字面最近的原文并写明"仅供判断是否口径不同，不构成答案"。之所以不用"结果为空"来判未覆盖、也不用相似度阈值：实测 <code class="i">hybridSearch</code> 是并集融合（词在教材里完全不存在时仍会返回向量近邻），其 <code class="i">distances</code> 是无上界、跨查询不可比的融合名次分。判定必须能被解释，所以只留这两条规则。</dd>
    </div>
    <div>
      <dt>卡点账本与复习队列<span class="tag">一条 UPDATE 就是状态机</span></dt>
      <dd>一次拒答写一行 <code class="i">sh_stuck</code> 流水（带当时的 512 维查询向量，便于事后复现"当时为什么没召回"）；同一问题再问只把 <code class="i">miss_count</code> +1，队列行数恒为 1。状态机 <code class="i">open → reviewing → mastered</code>（含回退 open）由一条带前驱守卫的 <code class="i">UPDATE ... WHERE id=? AND status IN (...)</code> 完成，用 <code class="i">affectedRows</code> 裁决：同一行同时发两次同样的流转，一条 200、另一条 409，<code class="i">status_changed_at</code> 只推进一次。id 由「资料集 + 原问题」现算，不依赖自增。</dd>
    </div>
  </dl>
</section>

<section id="data">
  <h2><span class="no">04</span>实测数据</h2>
  <p>下面每个数字都来自仓库里的 <code class="i">evidence/verify-log.txt</code> 与 <code class="i">evidence/verify.json</code>，是 <code class="i">npm run verify</code> 的原始输出，不是估算。</p>

  <h3>端到端验收：24 项全通过，退出码 0，全程 4.19 秒</h3>
  <div class="scroll">
  <table>
    <tr><th>验收点</th><th>实测</th></tr>
    <tr><td>导入幂等</td><td>同一篇重复导入两次均 33 切片，集合内 id 全唯一，与登记表 <code class="i">chunk_count</code> 一致</td></tr>
    <tr><td>就绪门槛（负例）</td><td>构造"表行数 33 / 向量通道可召回 0"，12 次探测全不放行，300 ms 上限后报错并写出实际与期望</td></tr>
    <tr><td>就绪门槛（正例）</td><td>第 2 次读数 33/33、第 3 次与上次相同才放行</td></tr>
    <tr><td>四种检索形态</td><td>全文硬过滤（<code class="i">$contains</code> 单独调用：存在的词 1 条且字面含词、不存在的词 0 条）；向量通道给出有界 cosine（0.461 / 0.474 / 0.529 / 0.529 / 0.554）；融合层只加权不裁剪（全文命中被顶到第 1，其余由向量补位）；多路 k+1 通道（3 词 → 3 条全文 + 1 条向量）</td></tr>
    <tr><td>引用可核对</td><td>证据卡 <code class="i">char_start–char_end</code> 与库内正文逐字一致（全文 1233 字）；<b>每个查询词必须是原问题的子串</b>、每条原句必须能在原文定位，否则断言失败</td></tr>
    <tr><td>复习闭环</td><td>卡点落库、错次累加、状态机 200/409/400/404、并发只推进一次、mastered 后离队、复习页非空与空态</td></tr>
    <tr><td>红线自检</td><td><code class="i">cloudModelCalls:"forbidden"</code>、<code class="i">embeddingFunction:null</code>、本地模型与分词器在位、512 维 + ngram2</td></tr>
    <tr><td>长连接自愈</td><td>空闲断连这类错误重试一次即恢复，其它错误不被误重试</td></tr>
  </table>
  </div>

  <h3>时延：冷启动与稳态分开报</h3>
  <div class="scroll">
  <table>
    <tr><th>场景</th><th>实测</th><th>口径</th></tr>
    <tr><td>单词键查询（warm，5 次）</td><td class="num">40 / 57 / 59 / 59 / 69 ms</td><td>最大 69 ms</td></tr>
    <tr><td>三关键词 · 4 条通道串行（3 次）</td><td class="num">75 / 83 / 79 ms</td><td>中位 79、最大 83 ms</td></tr>
    <tr><td>另一篇资料集同形查询</td><td class="num">52 ms</td><td>3 条通道</td></tr>
    <tr><td>进程冷启动分项</td><td class="num">337 ms</td><td>模块 import 158 + 模型加载 158 + 首次推理 21</td></tr>
    <tr><td>导入 · 向量化 33 条切片</td><td class="num">146–428 ms</td><td>本地 ONNX，纯 CPU</td></tr>
    <tr><td>导入 · 就绪门槛</td><td class="num">425–446 ms</td><td>3 次轮询，间隔 200 ms、上限 10 s</td></tr>
    <tr><td>赛题要求 P95 ≤ 800 ms</td><td class="num">达标</td><td>早期首批样本曾到 1179 ms，那是冷启动而非稳态</td></tr>
  </table>
  </div>
  <p>本地向量化本身只占约 50 ms（模型常驻后），一次查询的大头是数据库往返：每条通道一次往返，而它们不能并发。</p>

  <h3>引用真实原文的两条样例</h3>
  <blockquote>
    问：<b>酶有什么特性</b> → 抽取式答案，三句全是库内原句<br>
    「酶具有高效性。」「酶具有专一性。」「每一种酶只能催化一种或一类化学反应，例如麦芽糖酶只能催化麦芽糖水解。」
    <span class="src">逐句挂 ref / charStart / charEnd，点引用跳到「原文」标签页对应位置；覆盖率 1 ≥ 0.34，置信 thin，答案 3 句。</span>
  </blockquote>
  <blockquote>
    问：<b>DNA甲基化怎么遗传给子代</b> → 拒答<br>
    「资料集『生物必修1-细胞代谢讲义』中没有讲到这个问题的原句。判据①：2 个查询词里，命中句覆盖 0 个（覆盖率 0 &lt; 0.34）；判据②：没有任何一句同时包含 2 个查询词。下面是字面最接近 2 条原文，仅供判断是否口径不同，不构成答案。」
    <span class="src">这段文案是服务端按两条判据现拼的，不是生成句。同时落账：卡点 rv_e847b9c2064cebea，status=open，miss_count=1，最近证据 doc_03ee62e3b9。</span>
  </blockquote>
</section>

<section id="shots">
  <h2><span class="no">05</span>截图与原始输出</h2>
  <p>四张图都是开发记录里的实拍（已内联进本页，断网也能看）；本页没有任何可点击的演示按钮，也不提供托管实例。</p>
  ${shots.map((s) => `<figure>
    <img src="${img(s.file)}" alt="${s.title}">
    <figcaption><b>${s.title}</b><br>${s.cap}</figcaption>
  </figure>`).join('\n  ')}

  <h3>验收日志尾部（<code class="i">evidence/verify-log.txt</code> 原文）</h3>
  <pre><code>[PASS] 时延：单词键查询 warm P95 ≤ 800 ms — 样本 40/57/59/59/69 ms（最大 69 ms ≤ 800）
       └ 有氧呼吸哪个阶段释放的能量最多（4 条通道）实测 75/83/79 ms；3 条通道的物理篇同形查询 52 ms
[PASS] 时延：多关键词 4 通道串行（记录实测，超 800 ms 只列已知限制） — 3 次 75/83/79 ms（中位 79 ≤ 800），最大 83 ms（达标）
[PASS] 死连接自愈：withReconnect 只重试这一类错误，且重试后真实取集合仍可用 — 死连接错误重试 1 次后成功；非法错误没有被误重试；单例重建后 openCollection 仍读到 33 条切片

合计 24 项：通过 24，失败 0</code></pre>

  <h3>就绪门槛的库内轮询（<code class="i">evidence/seed-log.txt</code> 同源）</h3>
  <pre><code>[ready] 第 1 次探测：表行数 33，向量通道可召回 0 → 读数 0（期望 33，上一次 -1）
[ready] 第 2 次探测：表行数 33，向量通道可召回 33 → 读数 33（期望 33，上一次 0）
[ready] 第 3 次探测：表行数 33，向量通道可召回 33 → 读数 33（期望 33，上一次 33）→ 放行</code></pre>
</section>

<section id="run">
  <h2><span class="no">06</span>三步跑起来</h2>
  <div class="note"><b>在线体验需本地启动。</b>本项目不调用任何云端服务，也不提供演示后端：页面、检索、判定、复习队列全部跑在你自己启动的进程和你自己的 seekdb 实例上。本页没有"试用""在线体验"之类的按钮。</div>
  <ol class="steps">
    <li>
      <h4>装依赖、配 seekdb</h4>
      <pre><code>npm install</code></pre>
      <p>复制 <code class="i">.env.example</code> 为 <code class="i">.env</code>，填你自己的 server 模式 seekdb：<code class="i">SEEKDB_HOST</code> / <code class="i">SEEKDB_PORT</code> / <code class="i">SEEKDB_USER</code> / <code class="i">SEEKDB_PASSWORD</code> / <code class="i">SEEKDB_DATABASE</code>。需要 Node ≥ 22.9。离线模型（量化 ONNX，24 MB）与分词器已随仓库提交，不需要下载、不需要 Python。</p>
    </li>
    <li>
      <h4>起服务</h4>
      <pre><code>npm start</code></pre>
      <p>默认监听 <code class="i">127.0.0.1:8790</code>（<code class="i">PORT</code> 可覆盖）。浏览器打开后：「提问」出证据卡与抽取式答案，「原文」按字符偏移高亮定位，「卡点复习」是复习队列。前端零构建，静态资源由服务端直接伺服。</p>
    </li>
    <li>
      <h4>导入示例资料并验收</h4>
      <pre><code>npm run seed
npm run verify</code></pre>
      <p><code class="i">seed</code> 导入仓库自带的两篇讲义（可重复执行，不会多出切片）；<code class="i">verify</code> 跑 24 项端到端验收，任一失败退出码非 0，并把明细写进 <code class="i">evidence/verify-log.txt</code> 与 <code class="i">evidence/verify.json</code>。之后打开 <code class="i">127.0.0.1:8790</code> 自己提问即可——也可以换成导入你自己的教材。</p>
    </li>
  </ol>
</section>

<section id="limits">
  <h2><span class="no">07</span>已知限制</h2>
  <ul class="limits">
    <li><b>回退到「还没懂」时，<code class="i">mastered_at</code> 会被清空。</b><span>一条 UPDATE 同时写 <code class="i">status / status_changed_at / mastered_at</code>，目标是这一列只描述当前状态；想保留"曾经掌握过"的历史需要另开一列，或去看 <code class="i">sh_stuck</code> 流水。验收里把"清空"这件事本身写成了断言。</span></li>
    <li><b>前端只做了 DOM 结构级验证，没有像素级截图。</b><span>验证方式是读渲染后的 DOM（卡片数量、按钮按服务端 <code class="i">allowed</code> 置灰、空资料集显示「还没有卡点」、控制台无报错）；截图工具在本环境不可用，样式与响应式布局需要打开页面自己过一眼。</span></li>
    <li><b>长期空闲后曾整体报 500，现已自愈，但仍建议演示前先跑一次 <code class="i">npm run seed</code>。</b><span>根因是到 seekdb 的那条长连接被服务端超时关掉后 SDK 不自愈；现在只对"死连接"这一类错误丢弃单例并重试一次，且只挂在"打开集合 / 原生 SQL"这两个写入之前的动作上——写到一半才断的本次仍会失败，由下一个请求自愈（不重试写入是为了不重复落库）。没有保活心跳。</span></li>
    <li><b>检索与入库在本进程内串行。</b><span>SDK 的 <code class="i">hybridSearch</code> 依赖连接上的会话变量，并发会互相覆盖参数，所以多路通道排队发。多实例部署需要换成库级隔离或每实例独立连接。</span></li>
    <li><b>示例语料是自写口径。</b><span>仓库里两篇讲义（物理必修1 动力学、生物必修1 细胞代谢，10 + 9 小节）是常见高中教材口径的自行撰写内容，不是任何出版社原文；文档与界面都不宣称是原文。真实教材需要你自己导入。</span></li>
    <li><b>复习队列没有"到期"算法。</b><span>排序只用 <code class="i">错次 DESC, 最近出现 ASC</code>，未实现间隔重复的 <code class="i">next_review_at</code> 到期计算。</span></li>
    <li><b>明确未实现（标为可选，返回 501，不做静默降级）：</b><span>口径体检、沉淀导出、管理面板。</span></li>
  </ul>
</section>

<section id="repo">
  <h2><span class="no">08</span>仓库</h2>
  <div class="repo">
    <p>代码、验收脚本与全部实测证据（<code class="i">evidence/</code>、<code class="i">docs/VERIFICATION.md</code>、<code class="i">docs/TECHNICAL.md</code>）：</p>
    <p><a href="${REPO_URL}" rel="noopener noreferrer">${REPO_URL}</a></p>
    <p style="margin:8px 0 0;color:var(--muted);font-size:14px">分支 <code class="i">2026-competition-ecosystem</code> 下的 <code class="i">qoder/shuzheng</code> 目录。</p>
  </div>
</section>

<footer>
  书证 · 教材口径复习助手 —— 「Qoder × OceanBase · Build with Qoder」参赛项目。
  存储 / 查询 / 检索由 seekdb 承担；向量化在本地进程内完成；全流程不调用任何云端大模型或 embedding 接口。
  本页为单文件静态页：内联样式、图片内联、无外部资源引用，断网可看。
</footer>

</div>
</body>
</html>
`;

fs.mkdirSync(path.join(ROOT, 'site'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'site/index.html'), html, 'utf8');
const bytes = Buffer.byteLength(html, 'utf8');
console.log(`site/index.html 写出 ${(bytes / 1024).toFixed(1)} KB（${bytes} 字节），内联图片 ${shots.length} 张`);
