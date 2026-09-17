/**
 * 启用 GitHub Pages（source = GitHub Actions）并等待首次部署。
 * 用法: node tools/gh-pages.mjs [--watch]
 *   token 从 GH_TOKEN 读。
 */
const REPO = 'caelori/wordrealm';
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN 为空');
  process.exit(1);
}
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wordrealm-deploy',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(path, init = {}) {
  const r = await fetch('https://api.github.com' + path, { headers: H, ...init });
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: r.ok, status: r.status, body };
}

// 1. 启用 Pages，source 必须是 workflow，否则 deploy-pages 会失败
const existing = await api(`/repos/${REPO}/pages`);
if (existing.status === 200) {
  console.log('Pages 已启用: ' + existing.body.html_url + '  build_type=' + existing.body.build_type);
  if (existing.body.build_type !== 'workflow') {
    const upd = await api(`/repos/${REPO}/pages`, {
      method: 'PUT',
      body: JSON.stringify({ build_type: 'workflow' }),
    });
    console.log('切换 build_type -> workflow: ' + upd.status);
  }
} else {
  const create = await api(`/repos/${REPO}/pages`, {
    method: 'POST',
    body: JSON.stringify({ build_type: 'workflow' }),
  });
  if (create.ok) {
    console.log('✅ 已启用 Pages（source = GitHub Actions）');
  } else {
    console.log(`❌ 启用失败 ${create.status}: ${JSON.stringify(create.body).slice(0, 300)}`);
    console.log('   token 需要 Pages: write 权限（classic token 用 repo scope 即可）');
    process.exit(1);
  }
}

// 2. 查看 workflow 运行状态
const runs = await api(`/repos/${REPO}/actions/runs?per_page=5`);
if (runs.status !== 200) {
  console.log(`\n无法读取 Actions 运行记录 (${runs.status})：token 缺 Actions 读权限`);
  process.exit(0);
}

const list = runs.body.workflow_runs ?? [];
if (list.length === 0) {
  console.log('\n还没有 workflow 运行记录。推送后会自动触发。');
  process.exit(0);
}

console.log('\n最近的 workflow 运行:');
for (const r of list) {
  console.log(`  #${r.run_number}  ${r.name}  ${r.status}/${r.conclusion ?? '-'}  ${r.head_sha.slice(0, 8)}`);
}

if (process.argv.includes('--watch')) {
  const target = list[0];
  console.log(`\n等待 #${target.run_number} 完成…`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const cur = await api(`/repos/${REPO}/actions/runs/${target.id}`);
    if (cur.status !== 200) break;
    const s = cur.body.status;
    const c = cur.body.conclusion;
    process.stdout.write(`\r  ${s}/${c ?? '-'}   `);
    if (s === 'completed') {
      console.log('\n');
      if (c === 'success') {
        const pages = await api(`/repos/${REPO}/pages`);
        console.log('✅ 部署成功');
        if (pages.status === 200) console.log('   地址: ' + pages.body.html_url);
      } else {
        console.log(`❌ 部署失败: ${c}`);
        // 拉失败步骤的日志摘要
        const jobs = await api(`/repos/${REPO}/actions/runs/${target.id}/jobs`);
        if (jobs.status === 200) {
          for (const j of jobs.body.jobs ?? []) {
            for (const st of j.steps ?? []) {
              if (st.conclusion === 'failure') {
                console.log(`   失败步骤: ${j.name} / ${st.name}`);
              }
            }
          }
        }
      }
      break;
    }
  }
}
