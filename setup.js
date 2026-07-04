// 노션 DB에 표준 속성을 자동 추가/보정. 빈 DB만 만들고 연결한 뒤 `npm run setup`.
// 이미 있는 속성은 건드리지 않고, 없는 것만 추가. Title 컬럼 이름도 맞춰줌.
const { NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_VERSION = "2022-06-28" } = process.env;
const P = {
  title: process.env.PROP_TITLE || "제목",
  date: process.env.PROP_DATE || "일정",
  assignee: process.env.PROP_ASSIGNEE || "담당",
  url: process.env.PROP_URL || "Linear 링크",
  milestone: process.env.PROP_MILESTONE || "마일스톤",
  type: process.env.PROP_TYPE || "Type",
  parent: process.env.PROP_PARENT || "상위 issue",
};
const H = { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };

async function main() {
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    console.error("NOTION_TOKEN / NOTION_DATABASE_ID 를 .env에 넣으세요.");
    process.exitCode = 1;
    return;
  }

  const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`, { headers: H });
  if (!r.ok) {
    console.error(`DB 조회 실패 ${r.status}: ${await r.text()}`);
    console.error("→ integration을 DB에 연결(··· → Connections)했는지, DB ID가 맞는지 확인하세요.");
    process.exitCode = 1;
    return;
  }
  const db = await r.json();
  const existing = db.properties || {};
  const patch = {};

  // 1) Title 컬럼 이름 맞추기 (DB엔 title이 하나 있음, 이름이 다르면 rename)
  const titleEntry = Object.entries(existing).find(([, p]) => p.type === "title");
  if (titleEntry && titleEntry[0] !== P.title) {
    patch[titleEntry[0]] = { name: P.title };
    console.log(`  Title "${titleEntry[0]}" → "${P.title}" 이름 변경`);
  }

  // 2) 없는 속성만 추가
  const want = [
    [P.date, { date: {} }, "Date"],
    [P.assignee, { people: {} }, "Person"],
    [P.url, { url: {} }, "URL"],
    [P.milestone, { select: {} }, "Select"],
    [P.type, { select: { options: [
      { name: "Issue", color: "blue" },
      { name: "서브이슈", color: "green" },
      { name: "마일스톤", color: "red" },
    ] } }, "Select(Issue/서브이슈/마일스톤)"],
    [P.parent, { rich_text: {} }, "Text"],
  ];
  for (const [name, def, label] of want) {
    if (existing[name]) console.log(`  이미 있음: "${name}" (${existing[name].type})`);
    else { patch[name] = def; console.log(`  추가: "${name}" (${label})`); }
  }

  if (!Object.keys(patch).length) {
    console.log("\n모든 속성이 이미 준비됨. 추가할 것 없음.");
    return;
  }

  const pr = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ properties: patch }),
  });
  if (!pr.ok) {
    console.error(`\n속성 추가 실패 ${pr.status}: ${await pr.text()}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n완료. 이제 `npm run check` 로 확인하고 `npm run poll` 실행하세요.");
}

main().catch((e) => {
  console.error("[setup] 에러:", e.message);
  process.exitCode = 1;
});
