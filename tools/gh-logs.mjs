/**
 * 拉取某次 workflow 运行的步骤日志（失败排查用）。
 * 用法: node tools/gh-logs.mjs [run_number]
 */
const REPO = 'caelori/wordrealm';
const token = process.env.GH_TOKEN;
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wordrealm',
  'X-GitHub-Api-Version': '2022-11-28',
};

const want = process.argv[2];

const runs = await (
  await fetch(`https://api.github.com/repos/${REPO}/actions/runs?per_page=10`, { headers: H })
).json();

const run = want
  ? (runs.workflow_runs ?? []).find(r => String(r.run_number) === String(want))
  : runs.workflow_runs?.[0];

if (!run) {
  console.log('找不到该运行');
  process.exit(1);
}

console.log(`#${run.run_number} ${run.name}  ${run.status}/${run.conclusion}  ${run.head_sha.slice(0, 8)}`);
console.log(`事件: ${run.event}   创建: ${run.created_at}`);
console.log(`详情页: ${run.html_url}\n`);

const jobs = await (
  await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}/jobs`, { headers: H })
).json();

for (const job of jobs.jobs ?? []) {
  console.log(`── Job: ${job.name}  ${job.status}/${job.conclusion}`);
  for (const st of job.steps ?? []) {
    const mark = st.conclusion === 'success' ? '✓' : st.conclusion === 'failure' ? '✗' : '·';
    console.log(`   ${mark} ${st.name}`);
  }
}

// 下载失败 job 的日志原文（zip 里是一堆 txt，这里只要失败步骤附近的内容）
const failedJob = (jobs.jobs ?? []).find(j => j.conclusion === 'failure');
if (failedJob) {
  console.log(`\n── 日志（job ${failedJob.id}）──`);
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/jobs/${failedJob.id}/logs`,
    { headers: H, redirect: 'follow' },
  );
  if (!res.ok) {
    console.log(`拉取日志失败: ${res.status} ${res.statusText}`);
  } else {
    const text = await res.text();
    // 日志是 zip 的二进制；若拿到的是文本就直接截取关键片段
    if (/^PK/.test(text.slice(0, 2))) {
      console.log('（返回的是 zip 压缩包，无法直接内联展示。请到上面的详情页查看。）');
    } else {
      const lines = text.split('\n');
      const idx = lines.findIndex(l => /##\[error\]|npm error|ERR!/.test(l));
      const start = Math.max(0, (idx === -1 ? lines.length : idx) - 40);
      console.log(lines.slice(start, start + 70).join('\n'));
    }
  }
}
