// Linear GraphQL 클라이언트 (Personal API key, admin 불필요).
const { LINEAR_API_KEY } = process.env;
const ENDPOINT = "https://api.linear.app/graphql";

async function gql(query, variables) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: LINEAR_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Linear ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j.errors) throw new Error("Linear GraphQL: " + JSON.stringify(j.errors));
  return j.data;
}

// Notion→Linear 역방향 업데이트 (수정 양방향용). input 예: { title, dueDate }
// dueDate는 YYYY-MM-DD(TimelessDate) 또는 null(마감 해제).
export async function updateIssue(id, input) {
  const d = await gql(
    `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }`,
    { id, input },
  );
  return d.issueUpdate?.success;
}

export async function getProjectName(projectId) {
  const d = await gql(`query($id:String!){ project(id:$id){ name } }`, { id: projectId });
  return d.project?.name;
}

// 리니어 사용자 이메일 → id 맵 (Notion→Linear 어사인용). 시작 시 1회 로드.
let linearUsers = {};
export async function loadLinearUsers() {
  linearUsers = {};
  let after = null;
  do {
    const d = await gql(`query($after:String){ users(first:250, after:$after){ nodes{ id email } pageInfo{ hasNextPage endCursor } } }`, { after });
    for (const u of d.users.nodes) if (u.email) linearUsers[u.email.toLowerCase()] = u.id;
    after = d.users.pageInfo.hasNextPage ? d.users.pageInfo.endCursor : null;
  } while (after);
  return Object.keys(linearUsers).length;
}
export const linearUserIdByEmail = (email) => (email ? linearUsers[email.toLowerCase()] || null : null);

// 마일스톤 자체 수정 (Notion→Linear). input 예: { name, targetDate }
export async function updateMilestone(id, input) {
  const d = await gql(
    `mutation($id:String!,$input:ProjectMilestoneUpdateInput!){ projectMilestoneUpdate(id:$id, input:$input){ success } }`,
    { id, input },
  );
  return d.projectMilestoneUpdate?.success;
}

// 프로젝트 마일스톤 + 프로젝트 시작일 (마일스톤 자체를 항목으로 동기화할 때)
export async function fetchProjectMilestones(projectId) {
  const d = await gql(
    `query($id:String!){ project(id:$id){ startDate projectMilestones{ nodes{ id name targetDate } } } }`,
    { id: projectId },
  );
  return {
    startDate: d.project?.startDate || null,
    milestones: d.project?.projectMilestones?.nodes || [],
  };
}

// 프로젝트에 속한 모든 이슈 (페이지네이션으로 전부 수집)
export async function fetchProjectIssues(projectId) {
  const out = [];
  let after = null;
  do {
    const d = await gql(
      `query($id:String!,$after:String){
        project(id:$id){
          issues(first:100, after:$after){
            nodes{ id identifier title description url createdAt updatedAt dueDate priority state{name} assignee{name email} projectMilestone{ id name } parent{ id identifier title } }
            pageInfo{ hasNextPage endCursor }
          }
        }
      }`,
      { id: projectId, after },
    );
    // project=null은 "빈 프로젝트"가 아니라 조회 실패 → throw로 거울 오작동 방지
    if (!d.project) throw new Error("프로젝트 조회 실패 (project=null)");
    const conn = d.project.issues;
    if (!conn) break;
    out.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return out;
}
