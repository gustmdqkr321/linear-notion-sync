// Notion 쓰기 로직 (웹훅/폴링 공용).
const {
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  NOTION_VERSION = "2022-06-28",
  // Notion DB 속성 이름 기본값 (표준 스키마). .env의 PROP_*로 덮어쓸 수 있음. 빈 값이면 미사용.
  PROP_TITLE = "제목",
  PROP_DATE = "일정",
  PROP_STATUS = "",
  PROP_PRIORITY = "",
  PROP_ASSIGNEE = "담당",
  PROP_IDENTIFIER = "",
  PROP_URL = "Linear 링크",
  PROP_MILESTONE = "마일스톤",
  PROP_TYPE = "Type",
  PROP_PARENT = "상위 issue",
  // "true"면 생성일~마감일 기간(start~end)으로, 아니면 마감일(없으면 생성일) 하루로
  DATE_RANGE = "false",
} = process.env;

export const HAS_TYPE = !!PROP_TYPE;
const TYPE_ISSUE = "Issue";
const TYPE_SUBISSUE = "서브이슈";
const TYPE_MILESTONE = "마일스톤";
// 이슈 Type: 부모 있으면 서브이슈, 아니면 Issue
export const issueType = (issue) => (issue.parent ? TYPE_SUBISSUE : TYPE_ISSUE);

const USE_DATE_RANGE = DATE_RANGE === "true";
const PRIORITY_LABEL = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };
const NOTION_HEADERS = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
};

// 노션 사용자 이메일↔id 맵 (담당자 Person 매칭용). 시작 시 1회 로드.
let userByEmail = {};
let emailById = {};
export async function loadUsers() {
  userByEmail = {};
  emailById = {};
  let cursor;
  do {
    const url = `https://api.notion.com/v1/users?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const r = await fetch(url, { headers: NOTION_HEADERS });
    if (!r.ok) throw new Error(`Notion users ${r.status}: ${await r.text()}`);
    const j = await r.json();
    for (const u of j.results || []) {
      if (u.type === "person" && u.person?.email) {
        userByEmail[u.person.email.toLowerCase()] = u.id;
        emailById[u.id] = u.person.email.toLowerCase();
      }
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return Object.keys(userByEmail).length;
}
export const notionUserIdByEmail = (email) => (email ? userByEmail[email.toLowerCase()] || null : null);
export const notionEmailById = (id) => (id ? emailById[id] || null : null);
// 이슈 담당자 → 노션 people 값 (매칭 실패/없음이면 빈 배열 = 담당 비움)
export const assigneePeople = (issue) => {
  const id = notionUserIdByEmail(issue.assignee?.email);
  return id ? [{ id }] : [];
};
export const HAS_MILESTONE = !!PROP_MILESTONE;
export const milestoneName = (issue) => issue.projectMilestone?.name || null;
export const HAS_PARENT = !!PROP_PARENT;
export const parentLabel = (issue) => (issue.parent ? `${issue.parent.identifier} ${issue.parent.title}` : "");

// ISO 타임스탬프를 날짜(YYYY-MM-DD)로. 캘린더에 종일 이벤트로 깔끔하게 뜨게.
export const toDay = (v) => (v ? String(v).slice(0, 10) : null);
export const PROPS = { title: PROP_TITLE, date: PROP_DATE };

// 유효 마감일: dueDate가 생성일 이후일 때만 사용 (백데이트는 무시 → 양방향 정합성).
export const effectiveDue = (issue) => {
  const c = toDay(issue.createdAt);
  const d = toDay(issue.dueDate);
  return d && c && d >= c ? d : null;
};

// 오늘 날짜 (YYYY-MM-DD). 노션 막대 시작일 기본값.
export const today = () => new Date().toISOString().slice(0, 10);

// 캘린더/간트 막대용 날짜값: 시작 ~ 마감일. start==end면 점으로(같은날 zero-length 방지).
// 양방향에서 "끝(end)=마감일"이 규칙 → N→L은 end를 dueDate로 되돌림.
export const bidiDate = (startDay, dueDay) => {
  if (startDay && dueDay) return dueDay > startDay ? { start: startDay, end: dueDay } : { start: dueDay }; // 마감이 시작 이전이면 마감일 점
  if (startDay) return { start: startDay };
  if (dueDay) return { start: dueDay };
  return null;
};

// Linear 이슈 -> Notion 페이지 속성 매핑.
// bidi=true면 날짜를 dueDate 단일값으로만 씀(양방향 정합성: dueDate↔Notion날짜). 마감 없으면 날짜 미설정.
export function buildNotionProperties(issue, { bidi = false } = {}) {
  const props = {};

  if (PROP_TITLE) {
    props[PROP_TITLE] = { title: [{ text: { content: issue.title || "(제목 없음)" } }] };
  }

  if (PROP_DATE) {
    if (bidi) {
      // 시작=오늘(노션에 담은 날) ~ 마감일 막대. 시작일은 이후 노션에서 조정 가능(sticky).
      const dv = bidiDate(today(), effectiveDue(issue));
      if (dv) props[PROP_DATE] = { date: dv };
    } else {
      const start = toDay(issue.dueDate || issue.createdAt);
      if (USE_DATE_RANGE && issue.createdAt && issue.dueDate) {
        props[PROP_DATE] = { date: { start: toDay(issue.createdAt), end: toDay(issue.dueDate) } };
      } else if (start) {
        props[PROP_DATE] = { date: { start } };
      }
    }
  }

  if (PROP_STATUS && issue.state?.name) {
    props[PROP_STATUS] = { select: { name: issue.state.name } };
  }
  if (PROP_PRIORITY && issue.priority != null) {
    props[PROP_PRIORITY] = { select: { name: PRIORITY_LABEL[issue.priority] ?? String(issue.priority) } };
  }
  if (PROP_ASSIGNEE) {
    // Person 속성: 이메일로 매칭된 노션 사용자. 매칭 안 되면 빈 배열(담당 비움).
    props[PROP_ASSIGNEE] = { people: assigneePeople(issue) };
  }
  if (PROP_MILESTONE) {
    const m = milestoneName(issue);
    props[PROP_MILESTONE] = { select: m ? { name: m } : null };
  }
  if (PROP_TYPE) props[PROP_TYPE] = { select: { name: issueType(issue) } };
  if (PROP_PARENT) {
    const pl = parentLabel(issue);
    props[PROP_PARENT] = { rich_text: pl ? [{ text: { content: pl } }] : [] };
  }
  if (PROP_IDENTIFIER && issue.identifier) {
    props[PROP_IDENTIFIER] = { rich_text: [{ text: { content: issue.identifier } }] };
  }
  if (PROP_URL && issue.url) {
    props[PROP_URL] = { url: issue.url };
  }
  return props;
}

// 이슈 설명을 페이지 본문으로 (2000자 제한 -> 청크 분할)
export function buildNotionChildren(issue) {
  if (!issue.description) return [];
  const chunks = issue.description.match(/[\s\S]{1,1900}/g) || [];
  return chunks.map((text) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  }));
}

export async function createNotionPage(issue, opts = {}) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: buildNotionProperties(issue, opts),
      children: buildNotionChildren(issue),
    }),
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  return res.json();
}

// 페이지 보관(아카이브). 리니어에 없는 항목 정리용.
export async function archivePage(pageId) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: NOTION_HEADERS,
    body: JSON.stringify({ archived: true }),
  });
  if (!r.ok) throw new Error(`Notion archive ${r.status}: ${await r.text()}`);
  return r.json();
}

// select 속성에서 유효하지 않은(리니어에 없는) 옵션 제거 → 드롭다운 정리.
// 유지 옵션은 id로만 보내 이름·색 보존. 유효 이름이 0개면 옵션 전체 제거(거울: 마일스톤 없음).
export async function pruneSelectOptions(propName, validNames) {
  if (!propName) return { removed: 0, names: [] };
  const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`, { headers: NOTION_HEADERS });
  if (!r.ok) throw new Error(`Notion db ${r.status}: ${await r.text()}`);
  const db = await r.json();
  const opts = db.properties?.[propName]?.select?.options || [];
  const stale = opts.filter((o) => !validNames.has(o.name));
  if (!stale.length) return { removed: 0, names: [] };
  const keep = opts.filter((o) => validNames.has(o.name)).map((o) => ({ id: o.id }));
  const p = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`, {
    method: "PATCH",
    headers: NOTION_HEADERS,
    body: JSON.stringify({ properties: { [propName]: { select: { options: keep } } } }),
  });
  if (!p.ok) throw new Error(`Notion prune-opts ${p.status}: ${await p.text()}`);
  return { removed: stale.length, names: stale.map((o) => o.name) };
}

// DB의 (보관 안 된) 모든 페이지 id/제목 (거울 정리용)
export async function queryDbPageIds() {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: "POST",
      headers: NOTION_HEADERS,
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Notion query ${r.status}: ${await r.text()}`);
    const j = await r.json();
    for (const p of j.results || []) {
      out.push({ id: p.id, title: (p.properties?.[PROP_TITLE]?.title || []).map((t) => t.plain_text).join("") });
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}

// 이슈 설명 변경 시 노션 페이지 본문 교체 (기존 블록 삭제 후 새로 추가). Linear→Notion 단방향.
export async function replaceNotionBody(pageId, issue) {
  const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers: NOTION_HEADERS });
  if (r.ok) {
    const j = await r.json();
    for (const b of j.results || []) {
      await fetch(`https://api.notion.com/v1/blocks/${b.id}`, { method: "DELETE", headers: NOTION_HEADERS });
    }
  }
  const children = buildNotionChildren(issue);
  if (children.length) {
    const p = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: "PATCH",
      headers: NOTION_HEADERS,
      body: JSON.stringify({ children }),
    });
    if (!p.ok) throw new Error(`Notion body ${p.status}: ${await p.text()}`);
  }
}

// 마일스톤 자체를 항목으로 생성 (Type=마일스톤, 제목=이름, 일정=막대 dateObj)
export async function createMilestonePage(name, dateObj) {
  const props = {
    [PROP_TITLE]: { title: [{ text: { content: name || "(마일스톤)" } }] },
    [PROP_TYPE]: { select: { name: TYPE_MILESTONE } },
  };
  if (PROP_DATE && dateObj) props[PROP_DATE] = { date: dateObj };
  // 자기 이름을 마일스톤 속성에도 → "Color by 마일스톤"으로 마일스톤별 색 구분
  if (PROP_MILESTONE) props[PROP_MILESTONE] = { select: { name } };
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: NOTION_HEADERS,
    body: JSON.stringify({ parent: { database_id: NOTION_DATABASE_ID }, properties: props }),
  });
  if (!r.ok) throw new Error(`Notion milestone ${r.status}: ${await r.text()}`);
  return r.json();
}

// 페이지의 제목/날짜 필드 읽기 (양방향 비교용)
export async function getPageFields(pageId) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: NOTION_HEADERS });
  if (!r.ok) throw new Error(`Notion get ${r.status}: ${await r.text()}`);
  const p = await r.json();
  if (!p || typeof p !== "object" || !p.properties) throw new Error("Notion 응답 이상(properties 없음) — 동기화 보류");
  if (p.archived) return { archived: true };
  // 설정된 속성이 페이지 스키마에 없으면(컬럼 rename/삭제/오타) throw → reconcile 조기 return.
  // "컬럼 없음"을 "빈 값"으로 오독해 Linear 데이터를 대량 삭제하는 것을 원천 차단.
  for (const nm of [PROP_TITLE, PROP_DATE, PROP_ASSIGNEE, PROP_MILESTONE, PROP_TYPE, PROP_PARENT]) {
    if (nm && !(nm in p.properties)) throw new Error(`Notion 속성 "${nm}" 없음 (컬럼 rename/삭제?) — 동기화 보류`);
  }
  const title = (p.properties?.[PROP_TITLE]?.title || []).map((t) => t.plain_text).join("");
  const dprop = p.properties?.[PROP_DATE]?.date;
  // 양방향 규칙: 마감일 = 막대의 끝(end). end 없으면(점) 마감 없음.
  const due = dprop?.end ? toDay(dprop.end) : null;
  const start = dprop?.start ? toDay(dprop.start) : null;
  // 담당: 첫 번째 사람의 노션 user id (양방향 1명 기준)
  const assignee = PROP_ASSIGNEE ? p.properties?.[PROP_ASSIGNEE]?.people?.[0]?.id || null : null;
  const type = PROP_TYPE ? p.properties?.[PROP_TYPE]?.select?.name || null : null;
  const milestone = PROP_MILESTONE ? p.properties?.[PROP_MILESTONE]?.select?.name || null : null;
  const parent = PROP_PARENT ? (p.properties?.[PROP_PARENT]?.rich_text || []).map((t) => t.plain_text).join("") : "";
  return { archived: false, title, due, start, assignee, type, milestone, parent, lastEdited: p.last_edited_time };
}

// 제목/날짜 부분 업데이트. 넘긴 필드만 반영. date는 Notion date 객체({start,end}|{start}|null).
export const HAS_ASSIGNEE = !!PROP_ASSIGNEE;

export async function updatePageFields(pageId, fields) {
  const props = {};
  if ("title" in fields) props[PROP_TITLE] = { title: [{ text: { content: fields.title || "(제목 없음)" } }] };
  if ("date" in fields) props[PROP_DATE] = { date: fields.date };
  if ("assignee" in fields) props[PROP_ASSIGNEE] = { people: fields.assignee }; // [{id}] | []
  if ("milestone" in fields) props[PROP_MILESTONE] = { select: fields.milestone ? { name: fields.milestone } : null };
  if ("type" in fields) props[PROP_TYPE] = { select: { name: fields.type } };
  if ("parent" in fields) props[PROP_PARENT] = { rich_text: fields.parent ? [{ text: { content: fields.parent } }] : [] };
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: NOTION_HEADERS,
    body: JSON.stringify({ properties: props }),
  });
  if (!r.ok) throw new Error(`Notion update ${r.status}: ${await r.text()}`);
  return r.json();
}
