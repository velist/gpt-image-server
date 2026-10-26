(() => {
  const section = document.getElementById('distributionSection');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '永久有效';
  let rows = [];
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'margin:auto;width:min(720px,94vw);max-height:90vh;overflow:auto;border:1px solid #d4d4d2;border-radius:14px;padding:24px;color:#0d0d0c';
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => { dialog.replaceChildren(); });
  async function request(path = '', options = {}) {
    const res = await fetch('/api/admin/distribution' + path, {
      ...options, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
    });
    const data = await res.json();
    if (res.status === 401) { dialog.close(); logout(); }
    if (!res.ok) throw new Error(data.error?.message || data.error || '请求失败');
    return data;
  }
  function notice(message) { document.getElementById('distNotice').textContent = message; }
  function open(html) {
    dialog.innerHTML = '<button class="top-btn" style="float:right" id="distClose">关闭</button>' + html;
    dialog.querySelector('#distClose').onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
  }
  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); button.textContent = '已复制'; }
    catch { button.textContent = '复制失败，请手动选择复制'; }
  }
  const example = () => `curl ${location.origin}/v1/images/generations \\\n+  -H "Authorization: Bearer YOUR_API_KEY" \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"model":"gpt-image-2","prompt":"一只在窗边晒太阳的猫","n":1,"size":"1024x1024"}'`;
  window.switchAdminSection = async distribution => {
    document.getElementById('websiteSection').hidden = distribution;
    section.hidden = !distribution;
    document.getElementById('websiteTab').className = distribution ? 'top-btn' : 'btn-primary';
    document.getElementById('distributionTab').className = distribution ? 'btn-primary' : 'top-btn';
    if (distribution) await load();
  };
  async function load() {
    section.innerHTML = `<div class="card card-body" style="margin-bottom:16px">
      <h2>API 分发</h2><p style="margin:8px 0 16px;color:var(--text-muted)">为外部客户创建独立密钥，按实际成功出图张数计费。请求进行中预占额度。</p>
      <div class="toolbar"><button class="btn-primary" id="distCreate">创建分发密钥</button><button class="top-btn" id="distRefresh">刷新</button><button class="top-btn" id="distDocs">接入说明</button>
      <input class="search-input" id="distSearch" placeholder="搜索客户名称或密钥前缀" aria-label="搜索分发密钥"></div>
      <p id="distNotice" role="status" style="color:var(--status-err)"></p></div>
      <div class="table-wrap" style="overflow-x:auto"><table><thead><tr><th>客户 / 密钥</th><th>状态</th><th>张数（已用 / 总额）</th><th>到期时间</th><th>并发</th><th>操作</th></tr></thead><tbody id="distRows"><tr><td colspan="6">加载中…</td></tr></tbody></table></div>`;
    document.getElementById('distCreate').onclick = () => edit();
    document.getElementById('distRefresh').onclick = load;
    document.getElementById('distDocs').onclick = docs;
    document.getElementById('distSearch').oninput = render;
    try { rows = (await request()).data; render(); }
    catch (error) { notice(error.message); document.getElementById('distRows').innerHTML = '<tr><td colspan="6">加载失败，请刷新重试</td></tr>'; }
  }
  function render() {
    const query = document.getElementById('distSearch').value.toLowerCase();
    const filtered = rows.filter(r => (r.name + r.prefix).toLowerCase().includes(query));
    document.getElementById('distRows').innerHTML = filtered.map(row => {
      const expired = row.expiresAt && Date.parse(row.expiresAt) <= Date.now();
      const status = !row.enabled ? '停用' : expired ? '到期' : row.remaining === 0 ? '额度用尽' : '可用';
      return `<tr><td><strong>${escape(row.name)}</strong><br><span class="key-text">${escape(row.prefix)}…</span></td>
        <td><span class="badge ${status === '可用' ? 'active' : 'disabled'}">${status}</span></td>
        <td>${row.usedImages} / ${row.maxImages === -1 ? '不限' : row.maxImages}<br><small>预占 ${row.reservedImages} · 剩余 ${row.remaining === -1 ? '不限' : row.remaining}</small></td>
        <td>${escape(date(row.expiresAt))}</td><td>${row.maxConcurrent}</td>
        <td><button class="btn-sm" data-action="edit" data-id="${row.id}">编辑</button> <button class="btn-sm" data-action="toggle" data-id="${row.id}">${row.enabled ? '停用' : '启用'}</button> <button class="btn-sm" data-action="logs" data-id="${row.id}">记录</button></td></tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center;padding:32px">暂无分发密钥</td></tr>';
    section.querySelectorAll('[data-action]').forEach(button => {
      button.onclick = async () => {
        const row = rows.find(r => r.id === button.dataset.id);
        if (button.dataset.action === 'edit') return edit(row);
        if (button.dataset.action === 'logs') return logs(row);
        button.disabled = true;
        try { await request('/' + row.id, { method: 'PATCH', body: JSON.stringify({ enabled: !row.enabled }) }); await load(); }
        catch (error) { notice(error.message); button.disabled = false; }
      };
    });
  }
  function edit(row) {
    let localExpiry = '';
    if (row?.expiresAt) {
      const value = new Date(row.expiresAt);
      localExpiry = new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    open(`<h2>${row ? '编辑分发密钥' : '创建分发密钥'}</h2><form id="distForm" style="margin-top:20px">
      <div class="field"><label for="distName">客户名称 / 备注</label><input id="distName" required maxlength="100" value="${escape(row?.name)}" placeholder="例如：张三的应用"></div>
      <div class="field"><label for="distMax">总张数（-1 表示不限，0 表示不可生成）</label><input id="distMax" type="number" min="-1" step="1" required value="${row?.maxImages ?? 100}"></div>
      <div class="field"><label for="distExpiry">到期时间（本地时区，留空为永久）</label><input id="distExpiry" type="datetime-local" value="${localExpiry}"></div>
      <div class="field"><label for="distConcurrent">最大并发请求数（1–10）</label><input id="distConcurrent" type="number" min="1" max="10" step="1" required value="${row?.maxConcurrent ?? 2}"></div>
      <p style="margin-bottom:16px;color:var(--text-muted)">${row ? `已用 ${row.usedImages} 张，预占 ${row.reservedImages} 张。增加总张数即可续充。` : '完整密钥只展示一次，请创建后复制保存。'}</p>
      <p id="distFormError" role="alert" style="color:var(--status-err)"></p><button class="btn-primary" id="distSave" type="submit">${row ? '保存修改' : '创建'}</button></form>`);
    document.getElementById('distForm').onsubmit = async event => {
      event.preventDefault();
      const button = document.getElementById('distSave');
      button.disabled = true;
      try {
        const expiry = document.getElementById('distExpiry').value;
        const data = await request(row ? '/' + row.id : '', { method: row ? 'PATCH' : 'POST', body: JSON.stringify({
          name: document.getElementById('distName').value,
          maxImages: Number(document.getElementById('distMax').value),
          expiresAt: expiry ? new Date(expiry).toISOString() : null,
          maxConcurrent: Number(document.getElementById('distConcurrent').value)
        }) });
        if (row) dialog.close();
        else {
          open(`<h2>密钥创建成功</h2><p style="margin:16px 0">请立即保存，关闭后无法再次查看完整密钥。</p><textarea id="distSecret" readonly style="width:100%;height:80px;padding:12px;word-break:break-all"></textarea><button id="distCopy" class="btn-primary" style="margin-top:12px">复制密钥</button><p style="margin-top:16px">Base URL：<code>${escape(location.origin)}/v1</code></p>`);
          document.getElementById('distSecret').value = data.key;
          document.getElementById('distCopy').onclick = event => copy(data.key, event.target);
        }
        await load();
      } catch (error) { document.getElementById('distFormError').textContent = error.message; button.disabled = false; }
    };
  }
  function docs() {
    open(`<h2>外部 API 接入说明</h2><p style="margin:16px 0">Base URL：<code>${escape(location.origin)}/v1</code><br>鉴权：<code>Authorization: Bearer YOUR_API_KEY</code><br>模型：<code>gpt-image-2</code></p>
      <p>POST /v1/images/generations：同步返回图片（默认 b64_json），n 为 1–10。客户端超时建议设为 360 秒。仅支持文生图。</p>
      <pre style="white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f4;padding:16px;margin:16px 0">${escape(example())}</pre><button class="btn-primary" id="distCopyExample">复制示例</button>
      <p style="margin:16px 0">GET /v1/usage：查询总额度、已用、预占和剩余张数。<br>GET /v1/models：查询可用模型。</p>
      <p>401：密钥错误；403：停用或到期；429：余额不足或并发已满；502：上游异常。已接收请求会返回 X-Request-Id，排查时请提供此 ID。</p>
      <p style="margin-top:12px">成功按实际返回张数扣减；明确拒绝会退回预占。超时、连接中断、服务重启等无法确定出图结果的请求保留预占，在「记录」中核对结算。请勿对 502 自动重试。</p>
      <p style="margin-top:12px">密钥仅限在服务端保存，勿放在公开网页代码中。线上分发数据加密持久化到 GitHub，操作可能需要数秒。503 表示持久化不可用，请管理员检查后重启；勿自动重试。请妥善保留 Render 中的 DISTRIBUTION_BACKUP_SECRET。</p>`);
    document.getElementById('distCopyExample').onclick = event => copy(example(), event.target);
  }
  async function logs(row) {
    open('<h2>调用记录</h2><p>加载中…</p>');
    try {
      const { data } = await request('/' + row.id + '/requests');
      const labels = { pending: '进行中', uncertain: '待核对', success: '成功', failed: '失败 / 已退回', reviewed: '人工结算' };
      open(`<h2>${escape(row.name)} · 最近 100 次调用</h2><div style="overflow-x:auto;margin-top:16px"><table><thead><tr><th>时间 / 请求 ID</th><th>状态</th><th>申请 / 扣减</th><th>处理</th></tr></thead><tbody>${data.map(r => `<tr><td>${escape(date(r.created_at))}<br><small style="word-break:break-all">${escape(r.id)}</small></td><td>${labels[r.status]}<br><small>${escape(r.error)}</small></td><td>${r.requested} / ${r.charged}</td><td>${r.status === 'uncertain' ? `<button class="btn-sm" data-settle="${r.id}" data-max="${r.requested}">核对结算</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="4">暂无调用记录</td></tr>'}</tbody></table></div><p id="distLogError" role="alert" style="color:var(--status-err)"></p>`);
      dialog.querySelectorAll('[data-settle]').forEach(button => {
        button.onclick = async () => {
          const value = prompt(`请先核对上游记录，再填写实际成功张数（0–${button.dataset.max}）。填 0 会退回全部预占。`);
          if (value === null || value.trim() === '') return;
          button.disabled = true;
          try { await request(`/${row.id}/requests/${button.dataset.settle}/settle`, { method: 'POST', body: JSON.stringify({ charged: Number(value) }) }); await logs(row); await load(); }
          catch (error) { document.getElementById('distLogError').textContent = error.message; button.disabled = false; }
        };
      });
    } catch (error) { open('<h2>加载失败</h2><p>' + escape(error.message) + '</p>'); }
  }
})();
