// 사용자 본인 환경에서 실행하는 자가진단 스크립트.
// 토큰을 어디에도 공유하지 않고, 아래 3가지를 스스로 검증한다:
//   1) integration이 DB에 Share(공유)돼 있는가  -> 404면 공유 안 됨
//   2) parent가 database_id로 동작하는가        -> 테스트 페이지 생성으로 확인
//   3) Date 속성 이름/타입이 맞는가              -> DB 스키마 검사
//
// 실행: node --env-file=.env check.js            (스키마 검사만)
//       node --env-file=.env check.js --create   (테스트 페이지까지 생성)
//       node --env-file=.env check.js --create --archive   (생성 후 바로 보관처리로 정리)

const {
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  NOTION_VERSION = "2022-06-28",
  PROP_TITLE = "Name",
  PROP_DATE = "Date",
  DATE_RANGE = "false",
} = process.env;

const args = process.argv.slice(2);
const doCreate = args.includes("--create");
const doArchive = args.includes("--archive");

const c = { ok: "\x1b[32m[OK]\x1b[0m", bad: "\x1b[31m[X]\x1b[0m", warn: "\x1b[33m[!]\x1b[0m" };

// 종료용 에러 — 스택 없이 메시지만 출력하고 exitCode=1 로 자연 종료한다.
class Die extends Error {}
const looksPlaceholder = (v) => !v || /^ntn_xxx$|^x{10,}$/.test(v.trim());

const notion = (path, init = {}) =>
  fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

async function main() {
  // 0) .env 값이 실제로 채워졌는지 먼저 확인 (플레이스홀더 방지)
  if (looksPlaceholder(NOTION_TOKEN))
    throw new Die("NOTION_TOKEN 이 비었거나 아직 예시값(ntn_xxx)입니다. .env에 실제 토큰을 넣으세요.");
  if (looksPlaceholder(NOTION_DATABASE_ID))
    throw new Die("NOTION_DATABASE_ID 가 비었거나 아직 예시값(xxxx...)입니다. .env에 실제 DB ID를 넣으세요.");

  // 1) & 3) DB 조회 + 스키마 검사
  console.log(`\nDB ${NOTION_DATABASE_ID} 조회 중...`);
  const dbRes = await notion(`/databases/${NOTION_DATABASE_ID}`);

  if (dbRes.status === 401)
    throw new Die("401 unauthorized — NOTION_TOKEN 이 틀렸습니다. (토큰 재확인 / 재발급)");
  if (dbRes.status === 404)
    throw new Die(
      "404 object_not_found\n" +
        "   → 원인 1순위: 이 DB에 integration이 Share(공유)되지 않았습니다.\n" +
        "     DB 풀페이지 → ••• → Connections(또는 Share) → integration 추가\n" +
        "   → 원인 2순위: DB ID가 틀렸거나, 사실은 page_id 입니다.",
    );
  if (!dbRes.ok) throw new Die(`DB 조회 실패 ${dbRes.status}: ${await dbRes.text()}`);

  const db = await dbRes.json();
  console.log(`${c.ok} DB 접근 OK — integration이 공유돼 있음`);
  console.log(`   제목: ${db.title?.map((t) => t.plain_text).join("") || "(제목 없음)"}`);

  const props = db.properties || {};
  const typeOf = (name) => props[name]?.type;

  // 제목 속성 검사
  if (typeOf(PROP_TITLE) === "title") {
    console.log(`${c.ok} 제목 속성 "${PROP_TITLE}" (title) OK`);
  } else if (props[PROP_TITLE]) {
    console.log(`${c.bad} "${PROP_TITLE}" 는 title이 아니라 ${typeOf(PROP_TITLE)} 타입입니다.`);
  } else {
    const actualTitle = Object.entries(props).find(([, p]) => p.type === "title")?.[0];
    console.log(`${c.bad} title 속성 "${PROP_TITLE}" 없음. 실제 title 컬럼명: "${actualTitle}" → PROP_TITLE 수정 필요`);
  }

  // Date 속성 검사
  if (typeOf(PROP_DATE) === "date") {
    console.log(`${c.ok} 날짜 속성 "${PROP_DATE}" (date) OK — 캘린더 뷰 기준축 사용 가능`);
  } else if (props[PROP_DATE]) {
    console.log(`${c.bad} "${PROP_DATE}" 는 date가 아니라 ${typeOf(PROP_DATE)} 타입입니다. (캘린더 뷰 불가)`);
  } else {
    console.log(`${c.warn} 날짜 속성 "${PROP_DATE}" 없음 → 캘린더 뷰가 안 됩니다. Date 타입 컬럼 추가 필요`);
  }

  console.log(`   전체 속성: ${Object.entries(props).map(([n, p]) => `${n}(${p.type})`).join(", ")}`);

  if (!doCreate) {
    console.log(`\n스키마 검사 끝. 실제 쓰기까지 확인하려면: node --env-file=.env check.js --create\n`);
    return;
  }

  // 2) parent=database_id 로 테스트 페이지 생성
  console.log(`\n테스트 페이지 생성 중 (parent: database_id)...`);
  const today = new Date().toISOString().slice(0, 10);
  const dateValue = DATE_RANGE === "true" ? { start: today, end: today } : { start: today };

  const createRes = await notion(`/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        [PROP_TITLE]: { title: [{ text: { content: "[TEST] linear-notion-sync 연결 확인" } }] },
        ...(typeOf(PROP_DATE) === "date" ? { [PROP_DATE]: { date: dateValue } } : {}),
      },
    }),
  });

  if (!createRes.ok) throw new Die(`페이지 생성 실패 ${createRes.status}: ${await createRes.text()}`);
  const page = await createRes.json();
  console.log(`${c.ok} 테스트 페이지 생성 성공 — 캘린더 뷰(${today})에 떠야 함`);
  console.log(`   URL: ${page.url}`);

  if (doArchive) {
    const arch = await notion(`/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
    console.log(arch.ok ? `${c.ok} 테스트 페이지 보관처리(정리) 완료` : `${c.warn} 보관처리 실패 — 수동 삭제 필요`);
  }

  console.log(`\n모든 확인 통과. 이제 Linear 웹훅만 붙이면 됩니다.\n`);
}

main().catch((err) => {
  console.error(`${c.bad} ${err.message}`);
  process.exitCode = 1; // process.exit()를 쓰지 않아 윈도우 libuv assertion 회피
});
