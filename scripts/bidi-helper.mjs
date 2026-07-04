// 양방향 e2e 테스트 헬퍼. node --env-file=.env scripts/bidi-helper.mjs <cmd> <a> <b>
const KEY = process.env.LINEAR_API_KEY;
const NT = process.env.NOTION_TOKEN;
const PT = process.env.PROP_TITLE, PD = process.env.PROP_DATE;
const [, , cmd, a, b] = process.argv;
const nh = { Authorization: "Bearer " + NT, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const lgql = (q, v) =>
  fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, variables: v }),
  }).then((r) => r.json());

if (cmd === "show-issue") {
  const d = await lgql(`query($id:String!){issue(id:$id){identifier title dueDate}}`, { id: a });
  console.log("LINEAR:", JSON.stringify(d.data.issue));
} else if (cmd === "edit-linear-title") {
  const d = await lgql(`mutation($id:String!,$t:String!){issueUpdate(id:$id,input:{title:$t}){success}}`, { id: a, t: b });
  console.log("linear title set:", d.data?.issueUpdate?.success ?? d.errors);
} else if (cmd === "show-page") {
  const p = await (await fetch(`https://api.notion.com/v1/pages/${a}`, { headers: nh })).json();
  console.log("NOTION:", JSON.stringify({ title: (p.properties[PT]?.title || []).map((x) => x.plain_text).join(""), date: p.properties[PD]?.date }));
} else if (cmd === "edit-notion-date") {
  const r = await fetch(`https://api.notion.com/v1/pages/${a}`, { method: "PATCH", headers: nh, body: JSON.stringify({ properties: { [PD]: { date: { start: b } } } }) });
  console.log("notion date set:", r.ok);
} else if (cmd === "cleanup") {
  if (a) await lgql(`mutation($id:String!){issueDelete(id:$id){success}}`, { id: a });
  if (b) await fetch(`https://api.notion.com/v1/pages/${b}`, { method: "PATCH", headers: nh, body: JSON.stringify({ archived: true }) });
  console.log("cleaned issue", a, "page", b);
}
