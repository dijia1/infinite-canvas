# Local Runtime Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop normal idle image-task polling from producing database error logs, while documenting the verified non-application causes behind the browser audit signals.

**Architecture:** The worker keeps polling at its current cadence, but its repository claim query uses a zero-row result rather than GORM's `ErrRecordNotFound` path. This preserves the existing atomic transaction and task-state behavior, and prevents GORM's logger from classifying an empty queue as an error. The React hydration warning and apparent damaged thumbnails are not changed because browser evidence attributes them to third-party DOM injection and transient lazy preview loading respectively.

**Tech Stack:** Go, GORM, SQLite unit tests, Bun/Next.js browser verification.

**Spec:** No separate specification; this plan is based on the 2026-09-02 local runtime audit.

## Global Constraints

- Preserve Portal authentication, task claim ordering, lease behavior, and all image-task state transitions.
- An empty image-task queue is a normal condition and must not emit `record not found` through GORM logging.
- Do not change application markup to mask a DOM mutation made by the user-installed Immersive Translate extension.
- Do not delete or alter user media while diagnosing preview state.
- Add a regression test before the production fix and run it red then green.

---

### Task 1: Make idle image-task claiming silent

**Files:**
- Modify: `repository/image_generation_task.go:100-130`
- Modify: `repository/image_generation_task_test.go`

**Interfaces:**
- Consumes: `ClaimNextImageGenerationTask(staleBefore, updatedAt string) (model.ImageGenerationTask, bool, error)`.
- Produces: the identical public result contract; no task returns `found == false, err == nil` without GORM emitting an `ErrRecordNotFound` trace.

- [ ] **Step 1: Write the failing regression test**

Create a GORM logger backed by `bytes.Buffer`, set it on the test database session, call `ClaimNextImageGenerationTask` on an empty database, and assert both the existing result contract and that the buffer does not contain `record not found`.

```go
func TestClaimNextImageGenerationTaskDoesNotLogAnEmptyQueueAsAnError(t *testing.T) {
    useImageTaskTestDB(t)
    var logs bytes.Buffer
    database, err := DB()
    if err != nil { t.Fatal(err) }
    db = database.Session(&gorm.Session{Logger: logger.New(log.New(&logs, "", 0), logger.Config{LogLevel: logger.Warn})})

    _, found, err := ClaimNextImageGenerationTask("2026-09-02T12:00:00Z", "2026-09-02T12:00:01Z")
    if err != nil || found { t.Fatalf("empty claim = found %v, err %v", found, err) }
    if strings.Contains(logs.String(), "record not found") { t.Fatalf("idle claim logged an error: %s", logs.String()) }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./repository -run TestClaimNextImageGenerationTaskDoesNotLogAnEmptyQueueAsAnError -count=1`

Expected: FAIL because `First` returns `gorm.ErrRecordNotFound`, which the configured GORM logger records before the repository converts it to an empty result.

- [ ] **Step 3: Implement the smallest query change**

Replace the candidate lookup's `First` branch with an ordered `Limit(1).Find(&candidate)` query. Check `result.Error`, then return normally when `result.RowsAffected == 0`; retain the transaction, status predicate, optimistic update predicate, and `RowsAffected == 0` race handling.

```go
result := query.Order("created_at asc").Limit(1).Find(&candidate)
if result.Error != nil { return result.Error }
if result.RowsAffected == 0 { return nil }
```

- [ ] **Step 4: Run the focused and repository tests**

Run:

```bash
go test ./repository -run 'TestClaimNextImageGenerationTaskDoesNotLogAnEmptyQueueAsAnError|TestImageGenerationTaskLookupAndClaimAreOwnerScoped' -count=1
go test ./repository
```

Expected: PASS; empty queues are silent, while queued tasks still claim once and state transitions remain owner-scoped.

- [ ] **Step 5: Commit**

```bash
git add repository/image_generation_task.go repository/image_generation_task_test.go
git commit -m "fix: silence idle image task polling"
```

### Task 2: Verify the audited client conditions without product-code changes

**Files:**
- No source-code changes.

**Interfaces:**
- Consumes: the Portal-routed local canvas page and browser DOM/console observation.
- Produces: verification evidence that the application restores a persisted canvas; the only React hydration mismatch is attributable to the injected direct `<html><div>` child, and all visible private material thumbnails eventually decode.

- [ ] **Step 1: Rebuild the local `app` container**

Run: `docker compose -f docker-compose.local.yml up -d --build app`

- [ ] **Step 2: Verify the persisted canvas through Portal**

Open `http://127.0.0.1:8080/apps/infinite-canvas/canvas`, open the existing persisted project, reload once, and verify its nodes/edges reappear with `已保存`.

- [ ] **Step 3: Capture browser root evidence**

Inspect `document.documentElement.children` and attributes after reload. Record any third-party direct child below `<html>` and extension-specific attributes; do not change source for externally injected markup.

- [ ] **Step 4: Verify lazy thumbnail completion**

Open 我的素材 and inspect visible `[data-material-card] img` elements. Assert each completed image has `naturalWidth > 0`; do not classify a card as corrupted solely because its lazy preview has not rendered during the first frame.
