#!/usr/bin/env node
// 从优秀示例 JSON 生成 SEO 友好的提示词落地页 prompts.html
// 同时刷新 sitemap.xml 的 lastmod。
//
// 运行：node scripts/build-seo.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EX_DIR = path.join(ROOT, '优秀示例');
const PUB_DIR = path.join(ROOT, 'public');
const SITE = 'https://gpt-image-server-xhnm.onrender.com';

const today = new Date().toISOString().slice(0, 10);

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _str(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join('，');
  if (typeof v === 'object') {
    const parts = Object.values(v).filter(p => typeof p === 'string' && p.trim());
    return parts.join(' · ');
  }
  return String(v);
}

function loadExamples() {
  if (!fs.existsSync(EX_DIR)) return [];
  return fs.readdirSync(EX_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(file => {
      const name = path.basename(file, '.json');
      const json = JSON.parse(fs.readFileSync(path.join(EX_DIR, file), 'utf8'));
      const img = path.join(EX_DIR, name + '.jpg');
      return {
        name,
        imgRel: fs.existsSync(img) ? `/examples-assets/${encodeURIComponent(name)}.jpg` : null,
        prompt: json.main_prompt || json.prompt || json.mainPrompt || '',
        style: _str(json.style),
        composition: _str(json.composition),
        lighting: json.lighting_and_colors || _str(json.style && json.style.lighting) || '',
        keyElements: _str(json.key_elements),
        details: _str(json.details),
        aspect: json.aspect_ratio || (json.generation_parameters && json.generation_parameters.aspect_ratio) || '',
        negative: _str(json.negative_prompt)
      };
    });
}

function renderItemHtml(item, idx) {
  const imgHtml = item.imgRel
    ? `<img src="${item.imgRel}" alt="${escapeHtml(item.name)} gpt-image-2 prompts 示例" loading="lazy" decoding="async" width="640" height="1138">`
    : '';
  return `
<article class="prompt-card" id="prompt-${idx + 1}">
  <div class="prompt-preview">${imgHtml}</div>
  <div class="prompt-body">
    <h2><span class="num">#${String(idx + 1).padStart(2, '0')}</span> ${escapeHtml(item.name)} · GPT-Image-2 Prompt</h2>
    <p class="meta"><strong>风格：</strong>${escapeHtml(item.style || '—')}</p>
    ${item.composition ? `<p class="meta"><strong>构图：</strong>${escapeHtml(item.composition)}</p>` : ''}
    ${item.lighting ? `<p class="meta"><strong>光影色彩：</strong>${escapeHtml(item.lighting)}</p>` : ''}
    ${item.aspect ? `<p class="meta"><strong>宽高比：</strong>${escapeHtml(item.aspect)}</p>` : ''}
    <h3>主提示词 Main Prompt</h3>
    <pre class="prompt-text">${escapeHtml(item.prompt)}</pre>
    ${item.keyElements ? `<h3>关键元素 Key Elements</h3><p>${escapeHtml(item.keyElements)}</p>` : ''}
    ${item.details ? `<h3>细节 Details</h3><p>${escapeHtml(item.details)}</p>` : ''}
    ${item.negative ? `<h3>反向提示词 Negative Prompt</h3><p class="neg">${escapeHtml(item.negative)}</p>` : ''}
  </div>
</article>`;
}

function buildPrompts() {
  const items = loadExamples();
  const cards = items.map(renderItemHtml).join('\n');

  const itemListLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'GPT-Image-2 Prompts 提示词大全',
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    numberOfItems: items.length,
    itemListElement: items.map((it, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: `${it.name} · GPT-Image-2 Prompt`,
      url: `${SITE}/prompts.html#prompt-${idx + 1}`
    }))
  };

  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'GPT-Image-2 prompts 是什么？',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'GPT-Image-2 prompts 是为 OpenAI gpt-image-2（GPT Image 2）模型编写的中文/英文提示词，用于生成或编辑图像。一份高质量的 gpt-image-2 prompts 通常包含主提示词、风格、构图、光影、关键元素、细节、宽高比与反向提示词。'
        }
      },
      {
        '@type': 'Question',
        name: '本站的 gpt-image2-prompts 模板可以直接使用吗？',
        acceptedAnswer: {
          '@type': 'Answer',
          text: '可以。每一个示例都包含可一键复制的中文主提示词，以及风格、构图、光影、宽高比等结构化字段，复制粘贴到任意 gpt-image-2 兼容客户端即可立即生成图像。'
        }
      },
      {
        '@type': 'Question',
        name: '如何在 GPT-Image-2 Studio 中使用这些 prompts？',
        acceptedAnswer: {
          '@type': 'Answer',
          text: '在工作台「示例画廊」中点击任意示例卡片，主提示词会自动填入生成面板，配置 API Key 后点击生成即可，支持自定义尺寸到 4K 与透明背景。'
        }
      },
      {
        '@type': 'Question',
        name: '没有 API Key 怎么获取？',
        acceptedAnswer: {
          '@type': 'Answer',
          text: '工作台内置二维码，微信扫码添加好友可领取 10 张免费体验额度，无需自行注册 OpenAI。'
        }
      }
    ]
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首页', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'GPT-Image-2 Prompts 提示词大全', item: `${SITE}/prompts.html` }
    ]
  };

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>GPT-Image-2 Prompts 提示词大全｜${items.length}+ 高质量 gpt-image2-prompts 模板</title>
<meta name="description" content="GPT-Image-2 Prompts 提示词大全，精选 ${items.length}+ 个高质量 gpt-image2-prompts 中文模板：写实人像、动漫国漫、古风汉服、城市夜景、杂志封面等，附风格/构图/光影/反向提示词，一键复制即开即用。">
<meta name="keywords" content="gpt-image2-prompts, gpt-image-2 prompts, GPT Image 2 提示词, GPT 生图提示词, gpt-image2 中文提示词, OpenAI gpt-image-2, AI 绘图提示词, 写实人像 prompts, 动漫 prompts, 古风 prompts">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${SITE}/prompts.html">
<link rel="alternate" hreflang="zh-CN" href="${SITE}/prompts.html">
<link rel="icon" type="image/png" href="/myqrcode.png">
<meta property="og:type" content="article">
<meta property="og:locale" content="zh_CN">
<meta property="og:site_name" content="GPT-Image-2 Studio">
<meta property="og:title" content="GPT-Image-2 Prompts 提示词大全｜${items.length}+ 高质量 gpt-image2-prompts 模板">
<meta property="og:description" content="${items.length}+ 个高质量 gpt-image-2 中文提示词模板，一键复制即开即用。">
<meta property="og:url" content="${SITE}/prompts.html">
<meta property="og:image" content="${SITE}/examples-assets/%E5%8F%A4%E4%BB%A3%E5%A5%B3%E5%AD%90.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="GPT-Image-2 Prompts 提示词大全">
<meta name="twitter:description" content="${items.length}+ 个高质量 gpt-image-2 中文提示词模板，一键复制即开即用。">
<meta name="twitter:image" content="${SITE}/examples-assets/%E5%8F%A4%E4%BB%A3%E5%A5%B3%E5%AD%90.jpg">
<script type="application/ld+json">${JSON.stringify(breadcrumbLd)}</script>
<script type="application/ld+json">${JSON.stringify(itemListLd)}</script>
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#fafaf9;--bg-raised:#ffffff;--text:#0d0d0c;--muted:#4f4f4d;
  --border:#e2e2e0;--accent:#0a6f49;--accent-faint:#e7f3ed;
  --r-md:8px;--r-lg:14px;
  --f-sans:"Inter",-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;
  --f-serif:"Instrument Serif",ui-serif,Georgia,serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--text);font-family:var(--f-sans);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.container{max-width:880px;margin:0 auto;padding:32px 20px 80px}
header.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.logo{display:flex;align-items:center;gap:10px;font-weight:600}
.logo-badge{width:28px;height:28px;border-radius:6px;background:#0d0d0c;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
.nav-back{font-size:13.5px;color:var(--muted)}
h1{font-family:var(--f-serif);font-size:44px;line-height:1.15;letter-spacing:-0.01em;margin:24px 0 12px;font-weight:400}
.lede{font-size:16px;color:var(--muted);margin-bottom:24px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:32px}
.tag{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:999px;background:var(--accent-faint);color:var(--accent);font-size:12px;font-weight:500}
.intro{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r-lg);padding:20px 24px;margin-bottom:40px}
.intro p{margin:8px 0;color:var(--muted);font-size:14.5px}
.intro strong{color:var(--text)}
.toc{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r-lg);padding:16px 20px;margin-bottom:48px}
.toc h2{font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;font-weight:600}
.toc ol{padding-left:20px;columns:2;column-gap:24px;font-size:13.5px}
.toc li{margin:4px 0;break-inside:avoid}
.prompt-card{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;margin-bottom:32px;display:grid;grid-template-columns:200px 1fr;gap:0}
@media (max-width:640px){.prompt-card{grid-template-columns:1fr}}
.prompt-preview{background:#f5f5f4;display:flex;align-items:center;justify-content:center;min-height:260px}
.prompt-preview img{width:100%;height:100%;max-height:320px;object-fit:cover;display:block}
.prompt-body{padding:20px 24px}
.prompt-body h2{font-family:var(--f-serif);font-size:22px;font-weight:400;line-height:1.3;margin-bottom:12px}
.prompt-body .num{display:inline-block;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px;color:var(--muted);margin-right:6px}
.prompt-body h3{font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin:18px 0 6px;font-weight:600}
.prompt-body p{font-size:14px;color:var(--text)}
.prompt-body p.meta{font-size:13px;color:var(--muted);margin:4px 0}
.prompt-body p.meta strong{color:var(--text);font-weight:600}
.prompt-text{font-size:13.5px;line-height:1.65;color:var(--text);background:#fafaf9;border:1px solid var(--border);border-radius:8px;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-family:var(--f-sans)}
.neg{color:#b42318;font-size:13px}
.cta{margin:48px 0 16px;text-align:center;padding:32px;background:var(--accent-faint);border-radius:var(--r-lg)}
.cta h2{font-family:var(--f-serif);font-size:30px;font-weight:400;margin-bottom:8px;color:var(--accent)}
.cta p{color:var(--muted);font-size:14.5px;margin-bottom:16px}
.btn{display:inline-flex;align-items:center;height:40px;padding:0 20px;border-radius:8px;background:var(--accent);color:#fff;font-size:14px;font-weight:500}
.btn:hover{background:#075d3d;text-decoration:none}
footer{margin-top:56px;padding-top:24px;border-top:1px solid var(--border);font-size:13px;color:var(--muted);text-align:center}
.faq{margin-top:48px}
.faq h2{font-family:var(--f-serif);font-size:28px;font-weight:400;margin-bottom:16px}
.faq details{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r-md);padding:14px 18px;margin-bottom:10px}
.faq summary{font-weight:600;cursor:pointer;font-size:14.5px}
.faq details[open] summary{margin-bottom:8px}
.faq p{font-size:14px;color:var(--muted);line-height:1.65}
</style>
</head>
<body>
<div class="container">

<header class="top">
  <a href="/" class="logo">
    <span class="logo-badge">G2</span>
    <span>GPT-Image-2 Studio</span>
  </a>
  <a href="/" class="nav-back">← 返回工作台</a>
</header>

<h1>GPT-Image-2 Prompts 提示词大全</h1>
<p class="lede">${items.length}+ 个高质量 <strong>gpt-image2-prompts</strong> 中文模板，覆盖人像、动漫、古风、城市、杂志、地图、纪实等主流题材，附风格、构图、光影、宽高比、反向提示词，一键复制即开即用。</p>

<div class="tags">
  <span class="tag">gpt-image2-prompts</span>
  <span class="tag">gpt-image-2 prompts</span>
  <span class="tag">GPT Image 2</span>
  <span class="tag">中文提示词</span>
  <span class="tag">写实人像</span>
  <span class="tag">动漫国漫</span>
  <span class="tag">古风汉服</span>
  <span class="tag">城市风光</span>
  <span class="tag">杂志封面</span>
</div>

<section class="intro">
  <p><strong>什么是 GPT-Image-2 Prompts？</strong>GPT-Image-2 prompts 是为 OpenAI <code>gpt-image-2</code>（GPT Image 2）模型编写的提示词。一份高质量的 gpt-image-2 prompt 通常包含：主提示词（main prompt）、风格（style）、构图（composition）、光影色彩（lighting and colors）、关键元素（key elements）、细节（details）、宽高比（aspect ratio）以及反向提示词（negative prompt）。</p>
  <p><strong>为什么需要结构化 prompts？</strong>结构化的提示词能让 gpt-image-2 模型更稳定地复现风格、构图与人物比例，避免「画错手」「文字水印」「比例失真」等常见问题。本站收录的 ${items.length} 个模板都是经过实际生成验证、可直接复用的中文 prompts。</p>
  <p><strong>如何使用？</strong>在下方任选一个示例，复制「主提示词」粘贴到工作台即可生成；或直接在 <a href="/">GPT-Image-2 Studio 工作台</a> 的「示例画廊」中点击对应卡片，提示词会自动填入生成面板，配置 API Key 后即可一键出图，支持自定义尺寸到 <strong>4K</strong> 与 <strong>透明背景</strong>。</p>
</section>

<nav class="toc" aria-label="目录">
  <h2>${items.length} 个 prompts 目录</h2>
  <ol>
    ${items.map((it, i) => `<li><a href="#prompt-${i + 1}">${escapeHtml(it.name)}</a></li>`).join('\n    ')}
  </ol>
</nav>

${cards}

<section class="faq">
  <h2>常见问题 FAQ</h2>
  <details open>
    <summary>GPT-Image-2 prompts 和 GPT-Image-1 / DALL·E 3 的 prompts 通用吗？</summary>
    <p>大部分自然语言描述可以通用，但 gpt-image-2 对中文支持更好、对结构化字段（style/composition/lighting）解析更精准。本站的模板都经过 gpt-image-2 实测，建议直接使用，效果稳定优于跨模型迁移。</p>
  </details>
  <details>
    <summary>本站的 gpt-image2-prompts 可以商用吗？</summary>
    <p>提示词文本本身无版权限制，可以自由复制使用。生成图片的版权请遵循 OpenAI <code>gpt-image-2</code> 的使用条款，商用前请确认 API 账户的商用授权状态。</p>
  </details>
  <details>
    <summary>没有 OpenAI API Key 可以试用吗？</summary>
    <p>可以。点击工作台右下角二维码加好友，可领取 <strong>10 张免费体验额度</strong>，无需自行注册 OpenAI。</p>
  </details>
  <details>
    <summary>支持参考图（reference image）编辑吗？</summary>
    <p>支持。GPT-Image-2 Studio 提供「图像编辑」模式，上传参考图后输入修改指令即可，常见场景包括换背景、换姿势、换风格、移除水印、补全画面等。</p>
  </details>
</section>

<div class="cta">
  <h2>立即体验 GPT-Image-2 在线生图</h2>
  <p>把上面任意一份 prompts 粘贴到工作台，3 秒出图。</p>
  <a href="/" class="btn">打开工作台 →</a>
</div>

<footer>
  © GPT-Image-2 Studio · 最后更新 ${today} · <a href="/">首页</a> · <a href="/sitemap.xml">Sitemap</a>
</footer>

</div>
</body>
</html>
`;

  fs.writeFileSync(path.join(PUB_DIR, 'prompts.html'), html, 'utf8');
  console.log(`[seo] prompts.html generated with ${items.length} items`);
  return items;
}

function refreshSitemap(items) {
  const itemUrls = items.map(it => {
    const enc = encodeURIComponent(it.name);
    return `  <url>
    <loc>${SITE}/prompts.html#prompt-${items.indexOf(it) + 1}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
    ${it.imgRel ? `<image:image>
      <image:loc>${SITE}/examples-assets/${enc}.jpg</image:loc>
      <image:title>${escapeHtml(it.name)} GPT-Image-2 Prompt</image:title>
    </image:image>` : ''}
  </url>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${SITE}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${SITE}/"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/"/>
  </url>
  <url>
    <loc>${SITE}/prompts.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
${itemUrls}
</urlset>
`;

  fs.writeFileSync(path.join(PUB_DIR, 'sitemap.xml'), xml, 'utf8');
  console.log(`[seo] sitemap.xml refreshed, ${items.length + 2} urls`);
}

const items = buildPrompts();
refreshSitemap(items);
console.log('[seo] done at', new Date().toISOString());
