# linear-notion-sync

Linear 프로젝트 ↔ Notion 캘린더 DB 동기화


---

## 설정

### 1. Notion DB
1. **빈 데이터베이스**(캘린더용) 하나 만들기 — 속성은 `npm run setup`이 자동 생성
2. DB → Connections → integration에서 connect_linear 검색해서 추가
3. DB URL의 `?v=` 앞 **32자리** = DB ID

### 2. Linear
- **Personal API key**: Settings → Security & access → Personal API keys
- **Project ID**: 아래로 목록 확인
  ```bash
  node --env-file=.env -e "fetch('https://api.linear.app/graphql',{method:'POST',headers:{Authorization:process.env.LINEAR_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({query:'{projects(first:50){nodes{id name}}}'})}).then(r=>r.json()).then(d=>d.data.projects.nodes.forEach(p=>console.log(p.id,p.name)))"
  ```

### 3. `.env` 
```ini
NOTION_TOKEN=ntn_xxx              # 승현에게 말하기
NOTION_DATABASE_ID=<내 DB 32자리>
LINEAR_API_KEY=lin_api_xxx        
LINEAR_PROJECT_ID=<내 프로젝트 32자리>
```

### 4. 실행
```bash
git clone <repo-url> && cd linear-notion-sync
cp .env.example .env     # 위 4개 채우기
npm install
npm run setup            # 노션 DB에 속성 자동 생성(제목/일정/담당/링크/마일스톤/Type/상위issue)
npm run check            # 연결 확인
npm run poll             # 시작 (계속 켜두면 주기적으로 동기화)
```

끝. Linear에서 이슈 만들고 Notion 캘린더에 반영됩니다.

---

## 메모
- 생성은 Linear에서만(노션에서 만든 건 정리됨). 노션에서 뭘 지워도 **Linear 데이터는 안 날아감**.
- 수정 양방향: 제목·일정·담당·마일스톤. 시작일은 노션 전용(기본 오늘).
