// 실제 Linear 프로젝트에 테스트 이슈를 생성한다 (e2e 검증용).
const KEY = process.env.LINEAR_API_KEY;
const PROJECT = process.env.LINEAR_PROJECT_ID;
const ENDPOINT = "https://api.linear.app/graphql";

async function gql(query, variables) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// 프로젝트가 속한 팀 id 확보 (issueCreate에 teamId 필요)
const t = await gql(`query($id:String!){ project(id:$id){ teams(first:1){ nodes{ id name } } } }`, { id: PROJECT });
const team = t.project.teams.nodes[0];
if (!team) throw new Error("프로젝트에 연결된 팀이 없음");

const due = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
const d = await gql(
  `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier title url } } }`,
  { input: { teamId: team.id, projectId: PROJECT, title: "[E2E테스트] 리니어→노션 검증", description: "이 이슈는 연동 검증용입니다. 확인 후 삭제 예정.", dueDate: due } },
);

console.log("팀:", team.name);
console.log("생성됨:", d.issueCreate.issue.identifier, d.issueCreate.issue.title);
console.log("ISSUE_ID:", d.issueCreate.issue.id);
