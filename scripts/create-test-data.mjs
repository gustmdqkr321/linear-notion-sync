// 테스트 데이터: 마일스톤 3개 × 이슈 3개 × 서브이슈 2개. 담당 없음, 마감 랜덤.
const KEY = process.env.LINEAR_API_KEY;
const PROJ = process.env.LINEAR_PROJECT_ID;
const gql = (q, v) =>
  fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, variables: v }),
  }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (off) => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const t = await gql(`query($id:String!){project(id:$id){teams(first:1){nodes{id name}}}}`, { id: PROJ });
const teamId = t.data.project.teams.nodes[0].id;
console.log("팀:", t.data.project.teams.nodes[0].name);

const msOffsets = [14, 35, 56]; // 마일스톤 target 오프셋(일)
for (let mi = 1; mi <= 3; mi++) {
  const target = day(msOffsets[mi - 1]);
  const ms = await gql(
    `mutation($i:ProjectMilestoneCreateInput!){projectMilestoneCreate(input:$i){projectMilestone{id}}}`,
    { i: { projectId: PROJ, name: `테스트 M${mi}`, targetDate: target } },
  );
  const msId = ms.data.projectMilestoneCreate.projectMilestone.id;
  console.log(`마일스톤 테스트 M${mi} (target ${target})`);
  await sleep(300);
  for (let ii = 1; ii <= 3; ii++) {
    const due = day(rnd(3, msOffsets[mi - 1]));
    const iss = await gql(`mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{id identifier}}}`, {
      i: { teamId, projectId: PROJ, projectMilestoneId: msId, title: `M${mi} 이슈${ii}`, dueDate: due },
    });
    const issId = iss.data.issueCreate.issue.id;
    console.log(`  이슈 ${iss.data.issueCreate.issue.identifier} (due ${due})`);
    await sleep(300);
    for (let si = 1; si <= 2; si++) {
      const sdue = day(rnd(3, msOffsets[mi - 1]));
      const sub = await gql(`mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{identifier}}}`, {
        i: { teamId, projectId: PROJ, parentId: issId, title: `M${mi} 이슈${ii} 서브${si}`, dueDate: sdue },
      });
      console.log(`    서브 ${sub.data.issueCreate.issue.identifier} (due ${sdue})`);
      await sleep(300);
    }
  }
}
console.log("완료: 마일스톤 3, 이슈 9, 서브이슈 18");
