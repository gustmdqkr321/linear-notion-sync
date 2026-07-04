// 폴링 동기화 (admin/웹훅 불필요).
//  - 생성: Linear → Notion 단방향 (이슈는 리니어에서만 생성)
//  - 수정: BIDIRECTIONAL=true면 제목/마감일 양방향 (양쪽 다 바뀌면 Linear 우선)
//
// 실행: node --env-file=.env poll.js          (계속 폴링)
//       node --env-file=.env poll.js --once    (1회)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createNotionPage, createMilestonePage, getPageFields, updatePageFields, replaceNotionBody, archivePage, queryDbPageIds, pruneSelectOptions, toDay, today, bidiDate, effectiveDue, loadUsers, notionUserIdByEmail, notionEmailById, assigneePeople, HAS_ASSIGNEE, HAS_MILESTONE, milestoneName, HAS_TYPE, HAS_PARENT, parentLabel, issueType } from "./notion.js";
import { fetchProjectIssues, fetchProjectMilestones, getProjectName, updateIssue, updateMilestone, loadLinearUsers, linearUserIdByEmail } from "./linear.js";

const {
  LINEAR_API_KEY,
  LINEAR_PROJECT_ID,
  POLL_INTERVAL_MS = "60000",
} = process.env;

// 아래 3개는 기본 true. 끄려면 .env에 명시적으로 "false" 설정.
const BIDI = process.env.BIDIRECTIONAL !== "false"; // 수정 양방향
const BACKFILL = process.env.INITIAL_BACKFILL !== "false"; // 기존 이슈도 반영
const MIRROR = process.env.MIRROR_DELETE !== "false"; // 리니어에 없는 노션 항목 보관(거울)
const ONCE = process.argv.includes("--once");
const STATE_FILE = path.join(import.meta.dirname, "synced.json");

for (const [k, v] of Object.entries({ LINEAR_API_KEY, LINEAR_PROJECT_ID })) {
  if (!v) {
    console.error(`[config] 필수 환경변수 누락: ${k}`);
    process.exit(1);
  }
}

// 상태: { __initialized__, links: { <issueId>: { pageId, fp: {title,due} } } }
//  - fp(fingerprint) = 마지막으로 양쪽을 일치시킨 값 → 어느 쪽이 바뀌었는지 판정 + 루프 방지
const loadState = () => {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s.links) s.links = {};
    if (!s.milestones) s.milestones = {};
    return s;
  } catch {
    return { __initialized__: false, links: {}, milestones: {} };
  }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 양방향 비교값: 제목 + 유효마감일(=막대 끝). created는 막대 시작(표시용).
// assignee = 이메일로 매칭된 노션 user id (Linear→Notion 단방향).
const linVal = (issue) => ({
  title: issue.title || "",
  due: effectiveDue(issue),
  created: toDay(issue.createdAt),
  assignee: HAS_ASSIGNEE ? notionUserIdByEmail(issue.assignee?.email) : null,
  milestone: HAS_MILESTONE ? milestoneName(issue) : null,
  parent: HAS_PARENT ? parentLabel(issue) : "",
  descHash: bodyHash(issue.description),
});
const eqf = (a, b) => (a ?? null) === (b ?? null);
const bodyHash = (s) => crypto.createHash("sha1").update(s || "").digest("hex"); // 설명 변경 감지
// 공백 + 제로폭/bidi 제어문자만 있으면 빈 값으로 취급 (보이지 않는 문자로 Linear 제목 파괴 방지)
const isBlank = (s) => {
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    const zw = c === 0x200b || (c >= 0x200c && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff;
    if (ch.trim() !== "" && !zw) return false; // 공백도 제로폭도 아닌 실제 글자 → 안 빔
  }
  return true;
};

// 마일스톤 공용 데이터 (틱마다 갱신). byName = 이름→id (이슈 마일스톤 N→L 매핑용)
let MS = { startDate: null, milestones: [], byName: {} };
// 담당자 매핑 맵이 정상 로드됐는지. 실패 시 담당을 건드리지 않음(la=null을 '해제'로 오인해 대량삭제 방지)
let usersReady = false;

// 기존 링크된 이슈 ↔ 페이지 양방향 조정 (필드별 판정)
async function reconcile(issue, link, state) {
  const lv = linVal(issue);
  let page;
  try {
    page = await getPageFields(link.pageId);
  } catch (e) {
    console.error(`  [warn] ${issue.identifier} 페이지 읽기 실패: ${e.message}`);
    return;
  }
  if (page.archived) {
    // 노션에서 삭제(보관)됐지만 Linear 이슈는 존재 → 거울: 재생성 (Linear가 진실)
    if (MIRROR) {
      try {
        const np = await createNotionPage(issue, { bidi: BIDI });
        link.pageId = np.id;
        link.fp = linVal(issue);
        saveState(state);
        console.log(`  [recreate] ${issue.identifier} 노션에서 삭제됨 → 재생성`);
      } catch (e) {
        console.error(`  [recreate fail] ${issue.identifier}: ${e.message}`);
      }
    } else {
      console.log(`  [skip] ${issue.identifier} Notion 페이지 보관됨`);
    }
    return;
  }
  const fp = link.fp || lv;
  // 마감일(막대 end) 읽기: 노션이 당일막대(start==end)를 점으로 붕괴시켜 end가 사라진 경우,
  // start가 직전 마감과 같으면 그 값을 마감으로 복구(유령 삭제 방지). 백데이트(생성일 이전)는 무시.
  let rawDue = page.due || (page.start && page.start === (fp.due ?? null) ? page.start : null);
  if (rawDue && rawDue < lv.created) rawDue = null;
  const nv = { title: page.title || "", due: rawDue, assignee: page.assignee ?? null, milestone: page.milestone ?? null };

  const toNotion = {};
  const toLinear = {};
  const resolved = {};
  for (const f of ["title", "due"]) {
    // N→L로 보낼 수 없는 무효/삭제값(빈 제목, 마감 null) → Linear 삭제 안 하고 Linear 우선 복원.
    const nvBad = (f === "title" && isBlank(nv[f])) || (f === "due" && nv[f] == null);
    const lc = !eqf(lv[f], fp[f]); // Linear에서 바뀜
    const nc = !nvBad && !eqf(nv[f], fp[f]); // Notion에서 바뀜(무효값은 변경으로 안 봄)
    if (nc && !lc) {
      resolved[f] = nv[f];
      if (!eqf(lv[f], nv[f])) toLinear[f] = nv[f];
    } else if (lc || nvBad) {
      // Linear 변경/충돌, 또는 노션이 무효/빔 → Linear 우선 (무효값을 Linear로 절대 안 보냄)
      resolved[f] = lv[f];
      if (!eqf(nv[f], lv[f])) toNotion[f] = lv[f];
    } else {
      resolved[f] = fp[f];
    }
  }

  // 담당자: 양방향(1명 기준). Notion 담당 첫 사람 ↔ Linear 어사인 (이메일로 상호 매핑).
  let pushNotionAssignee = false;
  let linAssigneeId; // undefined=변경없음, null=해제, string=지정
  if (HAS_ASSIGNEE && !usersReady) {
    resolved.assignee = fp.assignee ?? null; // 사용자맵 미준비 → 담당 건드리지 않고 지문만 유지
  } else if (HAS_ASSIGNEE) {
    const la = lv.assignee ?? null; // Linear 담당의 notion-id
    const na = nv.assignee ?? null; // Notion 담당 첫 사람 id
    const fa = fp.assignee ?? null;
    if (issue.assignee && la == null) {
      // Linear 담당이 있는데 노션으로 매핑 불가(게스트/이메일 불일치) → 노션발로 절대 덮지 않음
      resolved.assignee = fa;
    } else {
      const lc = !eqf(la, fa);
      if (na && !eqf(na, fa) && !lc) {
        // 노션에서 "유효한 사람"으로 변경 → Linear 반영(매핑되면), 아니면 Linear 우선 복원
        const linId = linearUserIdByEmail(notionEmailById(na));
        if (linId) { linAssigneeId = linId; resolved.assignee = na; }
        else { pushNotionAssignee = true; resolved.assignee = la; }
      } else if (lc) {
        pushNotionAssignee = true; // Linear 변경/충돌 → Notion, Linear 우선
        resolved.assignee = la;
      } else if (na == null && fa != null) {
        // 노션에서 담당 비움 → Linear 해제 안 함(never-clear). Linear 값 복원.
        pushNotionAssignee = true;
        resolved.assignee = la;
      } else {
        resolved.assignee = fa;
      }
    }
  }

  // 마일스톤: 양방향(이름 기준). Notion select ↔ Linear projectMilestone.
  let pushMilestone = false;
  let linMilestoneId; // undefined=변경없음, null=해제, string=지정
  if (HAS_MILESTONE) {
    const lm = lv.milestone ?? null; // (서브이슈는 부모 상속값)
    if (issue.parent) {
      // 서브이슈: 부모 마일스톤 상속 표시(단방향). Linear 서브이슈 마일스톤은 안 건드림.
      resolved.milestone = lm;
      if (!eqf(page.milestone ?? null, lm)) pushMilestone = true;
    } else {
      const nm = nv.milestone ?? null;
      const fm = fp.milestone ?? null;
      const lc = !eqf(lm, fm);
      const nc = !eqf(nm, fm);
      if (nc && !lc) {
        if (!nm) {
          pushMilestone = true; // 노션에서 비움 → Linear 해제 안 함(never-clear), Linear 복원
          resolved.milestone = lm;
        } else {
          const id = MS.byName[nm];
          if (id) { linMilestoneId = id; resolved.milestone = nm; }
          else { pushMilestone = true; resolved.milestone = lm; } // 리니어에 없는 이름 → Linear 복원
        }
      } else if (lc) {
        pushMilestone = true; // Linear 변경/충돌 → Notion, Linear 우선
        resolved.milestone = lm;
      } else {
        resolved.milestone = fm;
      }
    }
  }
  // Type: 일반=Issue / 서브이슈=서브이슈. 다르면 맞춤.
  const wantType = issueType(issue);
  const pushType = HAS_TYPE && page.type !== wantType;
  // 부모: Linear→Notion 단방향 (서브이슈의 부모 표시). 다르면 맞춤.
  const pushParent = HAS_PARENT && (page.parent || "") !== lv.parent;
  // 본문(설명): Linear→Notion 단방향. 리니어 설명 바뀔 때만 교체.
  // 레거시(해시 필드 없던 fp)는 재작성 없이 해시만 백필(빈 본문 파괴 방지).
  const legacyNoHash = fp.descHash === undefined;
  const pushBody = !legacyNoHash && lv.descHash !== fp.descHash;
  resolved.descHash = legacyNoHash ? lv.descHash : fp.descHash; // 성공 시에만 전진(아래)

  const nKeys = Object.keys(toNotion);
  const lKeys = Object.keys(toLinear);
  const linAssigneeChange = linAssigneeId !== undefined;
  const linMilestoneChange = linMilestoneId !== undefined;
  if (!nKeys.length && !lKeys.length && !pushNotionAssignee && !pushMilestone && !pushType && !pushParent && !pushBody && !linAssigneeChange && !linMilestoneChange) {
    if (!link.fp) {
      link.fp = resolved;
      saveState(state);
    }
    return;
  }
  if (nKeys.length || pushNotionAssignee || pushMilestone || pushType || pushParent) {
    const payload = {};
    if ("title" in toNotion) payload.title = toNotion.title;
    if ("due" in toNotion) payload.date = bidiDate(page.start || today(), toNotion.due); // 시작(sticky, 기본 오늘)~마감
    if (pushNotionAssignee) payload.assignee = assigneePeople(issue);
    if (pushMilestone) payload.milestone = lv.milestone;
    if (pushType) payload.type = wantType;
    if (pushParent) payload.parent = lv.parent;
    await updatePageFields(link.pageId, payload);
    const extra = [...(pushNotionAssignee ? ["assignee"] : []), ...(pushMilestone ? ["milestone"] : []), ...(pushType ? ["type"] : []), ...(pushParent ? ["parent"] : [])];
    console.log(`  [L→N] ${issue.identifier} {${[...nKeys, ...extra].join(",")}} → Notion`);
    await sleep(350);
  }
  if (pushBody) {
    try {
      await replaceNotionBody(link.pageId, issue);
      resolved.descHash = lv.descHash; // 성공 시에만 지문 전진 (실패면 옛 해시 유지 → 다음 틱 재시도)
      console.log(`  [L→N] ${issue.identifier} {body} → Notion`);
      await sleep(350);
    } catch (e) {
      console.error(`  [body fail] ${issue.identifier}: ${e.message}`);
    }
  }
  if (lKeys.length || linAssigneeChange || linMilestoneChange) {
    const input = {};
    if ("title" in toLinear) input.title = toLinear.title;
    if ("due" in toLinear) input.dueDate = toLinear.due; // null이면 마감 해제
    if (linAssigneeChange) input.assigneeId = linAssigneeId; // null이면 어사인 해제
    if (linMilestoneChange) input.projectMilestoneId = linMilestoneId; // null이면 마일스톤 해제
    await updateIssue(issue.id, input);
    const lk = [...lKeys, ...(linAssigneeChange ? ["assignee"] : []), ...(linMilestoneChange ? ["milestone"] : [])];
    console.log(`  [N→L] ${issue.identifier} {${lk.join(",")}} → Linear`);
  }
  link.fp = resolved;
  saveState(state);
}

// 마일스톤 자체를 노션 항목(막대)으로 동기화. 이름·목표일 양방향(충돌 시 Linear 우선).
// 막대 = 이전 마일스톤 target ~ 이번 target. 시작(start)은 계산값이라 표시용(역동기화 X).
async function syncMilestones(state) {
  if (!HAS_TYPE) return;
  const dated = MS.milestones.filter((m) => m.targetDate).sort((a, b) => (a.targetDate < b.targetDate ? -1 : 1));
  let prev = MS.startDate ? toDay(MS.startDate) : null;
  for (const m of dated) {
    const ltarget = toDay(m.targetDate);
    const link = state.milestones[m.id];

    if (!link) {
      // 생성 시 기본 시작 = 이전 마일스톤 target(체인). 이후엔 노션에서 지정한 값 유지.
      const dateObj = prev && prev < ltarget ? { start: prev, end: ltarget } : { start: ltarget };
      try {
        const page = await createMilestonePage(m.name, dateObj);
        state.milestones[m.id] = { pageId: page.id, fp: { name: m.name, target: ltarget } };
        saveState(state);
        console.log(`  [MS+] "${m.name}" ${dateObj.end ? `${dateObj.start}~${dateObj.end}` : dateObj.start}`);
        await sleep(350);
      } catch (e) {
        console.error(`  [MS fail] ${m.name}: ${e.message}`);
      }
      prev = ltarget;
      continue;
    }

    let page;
    try {
      page = await getPageFields(link.pageId);
    } catch (e) {
      console.error(`  [MS warn] ${m.name}: ${e.message}`);
      prev = ltarget;
      continue;
    }
    if (page.archived) { prev = ltarget; continue; }

    const fp = link.fp || { name: m.name, target: ltarget };
    const nname = page.title || "";
    // 목표일 = 막대 끝(end)에서만 읽음. 점(end 없음)은 start가 직전 목표일과 같을 때만 인정
    // (표시 전용 sticky 시작일이 목표일로 새어 Linear를 덮는 것 방지).
    const ntarget = page.due || (page.start && page.start === (fp.target ?? null) ? page.start : null);

    // 이름 (양방향). 노션 이름 비움/제로폭은 유효값 아님 → Linear 우선 복원(빈 이름 N→L 안 보냄).
    const msUpdate = {};
    const nnameEmpty = isBlank(nname);
    let rname;
    if (!nnameEmpty && nname !== fp.name && m.name === fp.name) { rname = nname; if (nname !== m.name) msUpdate.name = nname; }
    else if (m.name !== fp.name || nnameEmpty) { rname = m.name; }
    else rname = fp.name;

    // 목표일 (양방향). ntarget=null(무효/비움)은 절대 Linear로 안 보냄(never-clear).
    let rtarget;
    if (ntarget != null && !eqf(ntarget, fp.target) && eqf(ltarget, fp.target)) { rtarget = ntarget; if (!eqf(ltarget, ntarget)) msUpdate.targetDate = ntarget; }
    else if (!eqf(ltarget, fp.target)) { rtarget = ltarget; }
    else rtarget = fp.target;

    // 시작일은 노션에서 지정한 값 유지(sticky, 리니어엔 시작일 필드 없음). 끝(target)만 리니어와 맞춤.
    const dateObj = rtarget
      ? page.start && page.start < rtarget
        ? { start: page.start, end: rtarget }
        : { start: rtarget }
      : null;
    const notionUpdate = {};
    if (rname !== nname) notionUpdate.title = rname;
    if (HAS_MILESTONE && page.milestone !== rname) notionUpdate.milestone = rname; // 색 구분용 자기이름
    const wantDate = JSON.stringify({ s: dateObj?.start || null, e: dateObj?.end || null });
    const curDate = JSON.stringify({ s: page.start || null, e: page.due || null });
    if (wantDate !== curDate) notionUpdate.date = dateObj;

    try {
      if (Object.keys(msUpdate).length) {
        await updateMilestone(m.id, msUpdate);
        console.log(`  [MS N→L] "${rname}" {${Object.keys(msUpdate).join(",")}} → Linear`);
      }
      if (Object.keys(notionUpdate).length) {
        await updatePageFields(link.pageId, notionUpdate);
        console.log(`  [MS L→N] "${rname}" 갱신 → Notion`);
        await sleep(350);
      }
      if (link.fp?.name !== rname || link.fp?.target !== rtarget) {
        link.fp = { name: rname, target: rtarget }; // 실제 변경 시에만 저장(불필요 디스크쓰기 방지)
        saveState(state);
      }
    } catch (e) {
      console.error(`  [MS fail] ${m.name}: ${e.message}`);
    }
    prev = rtarget;
  }

  // 목표일이 사라진(삭제는 아님) 마일스톤: 노션 막대 end 제거(점) + 이름 동기화 + fp.target=null
  const datedIds = new Set(dated.map((m) => m.id));
  for (const m of MS.milestones) {
    if (m.targetDate || datedIds.has(m.id)) continue;
    const link = state.milestones[m.id];
    if (!link) continue;
    let page;
    try {
      page = await getPageFields(link.pageId);
    } catch {
      continue;
    }
    if (page.archived) continue;
    const upd = {};
    if (m.name !== (page.title || "")) upd.title = m.name;
    if (HAS_MILESTONE && page.milestone !== m.name) upd.milestone = m.name;
    if (page.due) upd.date = page.start ? { start: page.start } : null; // end 제거(점/비움)
    try {
      if (Object.keys(upd).length) {
        await updatePageFields(link.pageId, upd);
        console.log(`  [MS L→N] "${m.name}" 목표일 해제 → Notion`);
        await sleep(350);
      }
      if (link.fp?.name !== m.name || link.fp?.target != null) {
        link.fp = { name: m.name, target: null };
        saveState(state);
      }
    } catch (e) {
      console.error(`  [MS fail] ${m.name}: ${e.message}`);
    }
  }
}

// 거울 정리: 리니어에 없는 노션 페이지 보관 (삭제된 이슈/마일스톤 + 노션 수동생성)
// validMsIds=null이면 마일스톤 조회 실패로 간주 → 마일스톤 페이지를 건드리지 않고 전부 보존.
async function pruneOrphans(state, validIssueIds, validMsIds) {
  const keep = new Set();
  for (const [iid, v] of Object.entries(state.links)) {
    if (v.pageId === "__preexisting__") {
      if (!validIssueIds.has(iid)) delete state.links[iid];
      continue;
    }
    if (validIssueIds.has(iid)) {
      keep.add(v.pageId);
      continue;
    }
    try {
      await archivePage(v.pageId);
      delete state.links[iid]; // 보관 성공 시에만 링크 제거
      console.log(`  [prune] 삭제된 이슈 페이지 보관`);
      await sleep(200);
    } catch (e) {
      console.error("  [prune fail]", e.message);
    }
  }
  for (const [mid, v] of Object.entries(state.milestones)) {
    if (!validMsIds || validMsIds.has(mid)) {
      keep.add(v.pageId); // 조회 실패(null)거나 유효 → 보존
      continue;
    }
    try {
      await archivePage(v.pageId);
      delete state.milestones[mid];
      console.log(`  [prune] 삭제된 마일스톤 페이지 보관`);
      await sleep(200);
    } catch (e) {
      console.error("  [prune fail]", e.message);
    }
  }
  saveState(state);
  // __preexisting__ 링크가 있으면 실제 pageId를 몰라 정상 페이지를 오보관할 위험 → 수동생성 스윕 스킵
  if (Object.values(state.links).some((v) => v.pageId === "__preexisting__")) {
    console.warn("  [prune] __preexisting__ 링크 존재 → 수동생성 스윕 건너뜀(오보관 방지)");
    return;
  }
  // 노션에서 수동 생성돼 리니어에 없는 페이지 → 보관
  let pages;
  try {
    pages = await queryDbPageIds();
  } catch (e) {
    console.error("  [prune] DB 조회 실패:", e.message);
    return;
  }
  for (const p of pages) {
    if (keep.has(p.id)) continue;
    try {
      await archivePage(p.id);
      console.log(`  [prune] 리니어에 없는 노션 항목 보관: "${p.title}"`);
      await sleep(200);
    } catch (e) {
      console.error("  [prune fail]", e.message);
    }
  }
}

async function tick() {
  const state = loadState();
  const firstRun = !state.__initialized__;
  const issues = await fetchProjectIssues(LINEAR_PROJECT_ID);

  // 서브이슈는 부모 이슈의 마일스톤을 상속(표시용). 리니어 서브이슈엔 마일스톤이 없어도 노션엔 부모 것으로.
  const msById = new Map(issues.map((i) => [i.id, i.projectMilestone?.name || null]));
  for (const i of issues) {
    if (!i.projectMilestone && i.parent?.id && msById.get(i.parent.id)) {
      i.projectMilestone = { name: msById.get(i.parent.id) };
    }
  }

  // 마일스톤 데이터 1회 조회 (이슈-마일스톤 양방향 + 마일스톤 항목 동기화 공용)
  let msOk = !(HAS_MILESTONE || HAS_TYPE); // 마일스톤 기능 안 쓰면 ok 취급
  if (HAS_MILESTONE || HAS_TYPE) {
    try {
      const d = await fetchProjectMilestones(LINEAR_PROJECT_ID);
      MS = { startDate: d.startDate, milestones: d.milestones, byName: Object.fromEntries(d.milestones.map((m) => [m.name, m.id])) };
      msOk = true;
    } catch (e) {
      console.error("[ms] 조회 실패:", e.message); // MS는 이전 값 유지, 이번 틱 마일스톤 prune 스킵
    }
  }

  // 첫 실행 + 백필 off: 기존 이슈는 링크 없이 "본 것"으로만 기록
  if (firstRun && !BACKFILL) {
    state.__initialized__ = true;
    for (const i of issues) state.links[i.id] = { pageId: "__preexisting__", fp: null };
    saveState(state);
    await syncMilestones(state); // 마일스톤 항목은 백필 여부와 무관하게 동기화
    console.log(`[poll] 첫 실행 — 기존 이슈 ${issues.length}개 건너뜀(백필 off). 이후 새 이슈만.`);
    return;
  }

  let created = 0;
  let updated = 0;
  for (const issue of issues) {
    const link = state.links[issue.id];
    const needsCreate = !link || (link.pageId === "__preexisting__" && BACKFILL);

    if (needsCreate) {
      try {
        const page = await createNotionPage(issue, { bidi: BIDI });
        state.links[issue.id] = { pageId: page.id, fp: linVal(issue) };
        state.__initialized__ = true;
        saveState(state);
        console.log(`  [new] ${issue.identifier} "${issue.title}" → ${page.id}`);
        created++;
        await sleep(350);
      } catch (e) {
        console.error(`  [fail] ${issue.identifier}: ${e.message}`);
      }
      continue;
    }
    if (link.pageId === "__preexisting__") continue; // 백필 off로 스킵된 기존 이슈

    if (BIDI) {
      const before = JSON.stringify(link.fp);
      try {
        await reconcile(issue, link, state);
      } catch (e) {
        console.error(`  [reconcile fail] ${issue.identifier}: ${e.message}`); // 한 이슈 실패가 틱 전체를 막지 않게
      }
      if (JSON.stringify(link.fp) !== before) updated++;
      await sleep(150); // 읽기 페이싱
    }
  }
  state.__initialized__ = true;
  saveState(state);
  await syncMilestones(state); // 마일스톤 항목(막대) 동기화
  if (MIRROR) {
    const realLinks = Object.values(state.links).filter((v) => v.pageId !== "__preexisting__").length;
    if (!issues.length && realLinks > 0) {
      console.warn("  [prune] 이슈 0개인데 기존 링크 존재 → prune 건너뜀(조회 이상 방지). 의도적이면 synced.json 초기화.");
    } else {
      // 마일스톤 조회 실패(msOk=false)면 validMsIds=null로 넘겨 마일스톤 페이지/옵션 정리 스킵
      await pruneOrphans(state, new Set(issues.map((i) => i.id)), msOk ? new Set(MS.milestones.map((m) => m.id)) : null);
      if (HAS_MILESTONE && msOk) {
        try {
          const { removed, names } = await pruneSelectOptions(process.env.PROP_MILESTONE, new Set(MS.milestones.map((m) => m.name)));
          if (removed) console.log(`  [prune] 마일스톤 옵션 ${removed}개 정리: ${names.join(", ")}`);
        } catch (e) {
          console.error("  [prune opts] 실패:", e.message);
        }
      }
    }
  }
  console.log(`[poll] 완료 — 생성 ${created}, 갱신 ${updated}, 추적 ${issues.length}${BIDI ? " (양방향)" : ""}`);
}

async function loop() {
  try {
    await tick();
  } catch (err) {
    console.error("[poll] 에러:", err.message);
  }
  if (!ONCE) setTimeout(loop, Number(POLL_INTERVAL_MS));
}

const name = await getProjectName(LINEAR_PROJECT_ID).catch(() => "(이름 조회 실패)");
console.log(`대상 프로젝트: "${name}" (${LINEAR_PROJECT_ID})`);
if (HAS_ASSIGNEE) {
  const n = await loadUsers().catch((e) => { console.warn("[users] 노션 사용자 로드 실패:", e.message); return 0; });
  const l = await loadLinearUsers().catch((e) => { console.warn("[users] 리니어 사용자 로드 실패:", e.message); return 0; });
  usersReady = n > 0 && l > 0; // 둘 다 로드돼야 담당 동기화 활성 (미로드면 담당 안 건드림)
  console.log(`담당자 매칭: 노션 ${n}명 / 리니어 ${l}명 로드${usersReady ? "" : " — 로드 미완료로 담당 동기화 보류"}`);
}
console.log(`모드: ${BIDI ? "양방향(제목·마감일)" : "단방향 생성"} · ${ONCE ? "1회" : `폴링 ${Number(POLL_INTERVAL_MS) / 1000}초`}`);
await loop();
