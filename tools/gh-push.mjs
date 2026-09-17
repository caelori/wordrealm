/**
 * 用 GitHub REST API（Git Data API）推送本地提交。
 *
 * 为什么不用 git push：
 *   当前网络封锁了 github.com:443 与 raw.githubusercontent.com，
 *   但 api.github.com 可达。所以改走 API：blob -> tree -> commit -> 更新 ref。
 *
 * 用法: node tools/gh-push.mjs
 *   token 从环境变量 GH_TOKEN 读，不写文件、不打印。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 相对自身位置推导项目根目录，不写死绝对路径
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'caelori/wordrealm';
const BRANCH = 'main';
const API = 'https://api.github.com';

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
  const r = await fetch(API + path, { headers: { ...H, ...(init.headers ?? {}) }, ...init });
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    const msg = body && typeof body === 'object' ? body.message : String(text).slice(0, 300);
    // 403 最常见的原因是 token 权限不足，直接给出可操作的提示
    if (r.status === 403) {
      throw new Error(
        `${init.method ?? 'GET'} ${path} -> 403 ${msg}\n` +
          '   这几乎总是 token 权限问题，而不是代码问题。请检查：\n' +
          '   · fine-grained token：需在 Repository permissions 里把 Contents 设为 Read and write，\n' +
          '     并给 Pages 与 Actions 相应权限（每次改权限都要重新生成 token）\n' +
          '   · classic token：需要勾选 repo 与 workflow 两个 scope（推荐，一次到位）',
      );
    }
    if (r.status === 404) {
      throw new Error(`${init.method ?? 'GET'} ${path} -> 404 ${msg}\n   可能是仓库不存在，或 token 无权访问该仓库`);
    }
    if (r.status === 409) {
      throw new Error(`${init.method ?? 'GET'} ${path} -> 409 ${msg}\n   仓库为空时属正常，脚本会自动改走创建分支的路径`);
    }
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${r.status}\n${String(text).slice(0, 500)}`);
  }
  return body;
}

/** 列出 git 已跟踪的文件（相对于仓库根，正斜杠） */
function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(f => {
      try {
        return statSync(join(ROOT, f)).isFile();
      } catch {
        return false;
      }
    });
}

const GIT_MODES = { 100644: '100644', 100755: '100755', 120000: '120000' };

function gitMode(rel) {
  try {
    const out = execFileSync('git', ['ls-files', '-s', '--', rel], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const mode = out.split(/\s+/)[0];
    return GIT_MODES[mode] ?? '100644';
  } catch {
    return '100644';
  }
}

async function createBlob(rel) {
  const abs = join(ROOT, rel);
  const buf = readFileSync(abs);
  const isBinary = buf.includes(0) || /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf)$/i.test(rel);
  const content = buf.toString('base64');
  const blob = await api(`/repos/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'base64' }),
  });
  return { rel, sha: blob.sha, size: buf.length, binary: isBinary };
}

async function main() {
  // 1. 当前分支头。
  //    ⚠️ Git Data API 在「完全空的仓库」上会返回 409 Git Repository is empty，
  //    连 blob 都建不了。所以必须先想办法造出第一个提交。
  let parentSha = null;
  try {
    const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
    parentSha = ref.object.sha;
    console.log(`远端 ${BRANCH} 已有提交: ${parentSha.slice(0, 8)}`);
  } catch {
    console.log(`远端 ${BRANCH} 还是空的 —— 先用 Contents API 建立首个提交`);

    // 用 .gitignore 当破冰文件：它本来就是第一个提交里该有的东西，
    // 后面 Git Data API 会用完整快照覆盖掉它（内容一致，不会产生多余差异）
    const seedPath = '.gitignore';
    const seedContent = readFileSync(join(ROOT, seedPath));
    const created = await api(`/repos/${REPO}/contents/${encodeURIComponent(seedPath)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'chore: 初始化仓库',
        content: seedContent.toString('base64'),
        branch: BRANCH,
      }),
    });
    parentSha = created.commit.sha;
    console.log(`  已建立首个提交: ${parentSha.slice(0, 8)}`);
  }

  // 2. 本地提交信息
  const files = listTrackedFiles();
  console.log(`本地待推送文件: ${files.length} 个`);

  // 3. 并发上传 blob（限制并发，避免触发 secondary rate limit）
  const CONCURRENCY = 6;
  const blobs = [];
  let done = 0;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);
    const res = await Promise.all(chunk.map(createBlob));
    blobs.push(...res);
    done += res.length;
    process.stdout.write(`\r  上传 blob ${done}/${files.length}`);
  }
  process.stdout.write('\n');

  const big = blobs.filter(b => b.size > 1_000_000);
  if (big.length) {
    for (const b of big) console.log(`  大文件: ${b.rel} (${(b.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  // 4. 建 tree。不带 base_tree：这是一次完整快照，避免残留旧文件
  const tree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      tree: blobs.map(b => ({
        path: b.rel,
        mode: gitMode(b.rel),
        type: 'blob',
        sha: b.sha,
      })),
    }),
  });
  console.log(`tree: ${tree.sha.slice(0, 8)}`);

  // 5. commit 信息用本地 HEAD 的，保持一致
  const msg = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const authorName = 'Wordrealm';
  const authorEmail = 'noreply@local';

  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: msg,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
      author: { name: authorName, email: authorEmail, date: new Date().toISOString() },
      committer: { name: authorName, email: authorEmail, date: new Date().toISOString() },
    }),
  });
  console.log(`commit: ${commit.sha.slice(0, 8)}`);

  // 6. 更新分支引用
  if (parentSha) {
    await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  } else {
    await api(`/repos/${REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
    });
  }
  console.log(`\n✅ 已推送到 ${REPO} 的 ${BRANCH} 分支`);
  console.log(`   ${commit.sha}`);
}

main().catch(e => {
  console.error('\n❌ ' + e.message);
  process.exit(1);
});
