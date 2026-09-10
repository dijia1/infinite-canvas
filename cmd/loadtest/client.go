package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/google/uuid"
)

func neturlLocalDSN(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() != "127.0.0.1" || u.Path != "/infinite_canvas_test" {
		return nil, fmt.Errorf("only 127.0.0.1/infinite_canvas_test is allowed")
	}
	return u, nil
}

type response struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
	Msg  string          `json:"msg"`
}
type observation struct {
	Time             time.Time `json:"time"`
	User             int       `json:"user"`
	Scenario         string    `json:"scenario"`
	Phase            string    `json:"phase"`
	API              string    `json:"api"`
	Status           int       `json:"status"`
	Code             int       `json:"code"`
	Milliseconds     float64   `json:"ms"`
	Bytes            int       `json:"bytes"`
	ExpectedBusiness bool      `json:"expected_business"`
	Error            string    `json:"error,omitempty"`
}
type driver struct {
	base             string
	client           *http.Client
	start            time.Time
	ramp, hold, down time.Duration
	mu               sync.Mutex
	events           *json.Encoder
	failures         []string
	requests         atomic.Int64
	active           atomic.Int64
	peak             atomic.Int64
}

func (d *driver) phase() string {
	e := time.Since(d.start)
	if e < 0 {
		return "preflight"
	}
	if e < d.ramp {
		return "ramp_up"
	}
	if e < d.ramp+d.hold {
		return "steady"
	}
	if e < d.ramp+d.hold+d.down {
		return "ramp_down"
	}
	return "verify"
}
func (d *driver) failure(s string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.failures) < 100 {
		d.failures = append(d.failures, s)
	}
}
func (d *driver) request(user int, uid, scenario, api, method, path string, body any, expect string) (response, bool) {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			d.failure("encode: " + err.Error())
			return response{}, false
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(data))
	if err != nil {
		d.failure(err.Error())
		return response{}, false
	}
	if uid != "" {
		req.Header.Set("X-Portal-User-Uid", uid)
		req.Header.Set("X-Portal-Username", uid)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Canvas-Request-Id", uuid.NewString())
	req.Header.Set("X-Canvas-Tab-Id", fmt.Sprintf("load-%d-%s", user, scenario))
	req.Header.Set("X-Canvas-Save-Reason", "autosave")
	started := time.Now()
	res, e := d.client.Do(req)
	o := observation{Time: started, User: user, Scenario: scenario, API: api, Phase: d.phase()}
	payload := response{}
	ok := false
	if e != nil {
		o.Error = e.Error()
	} else {
		raw, readErr := io.ReadAll(io.LimitReader(res.Body, 8<<20))
		res.Body.Close()
		o.Status = res.StatusCode
		o.Bytes = len(raw)
		if readErr != nil {
			o.Error = readErr.Error()
		} else if e := json.Unmarshal(raw, &payload); e != nil {
			o.Error = "invalid JSON response"
		} else {
			o.Code = payload.Code
			switch expect {
			case "401":
				ok = o.Status == 401 && payload.Code != 0
			case "403":
				ok = o.Status == 403 && payload.Code != 0
			case "409":
				ok = o.Status == 409 && payload.Code != 0
			case "denied":
				ok = (o.Status == 200 || o.Status == 403 || o.Status == 404) && payload.Code != 0 && string(payload.Data) == "null"
			case "race":
				ok = (o.Status == 200 && payload.Code == 0) || (o.Status == 409 && payload.Code != 0)
			default:
				ok = o.Status >= 200 && o.Status < 300 && payload.Code == 0
			}
			if !ok {
				o.Error = fmt.Sprintf("unexpected status/code %d/%d: %s", o.Status, payload.Code, payload.Msg)
			}
			o.ExpectedBusiness = ok && expect != "" && payload.Code != 0
		}
	}
	o.Milliseconds = float64(time.Since(started)) / float64(time.Millisecond)
	d.requests.Add(1)
	d.mu.Lock()
	d.events.Encode(o)
	d.mu.Unlock()
	if !ok {
		d.failure(fmt.Sprintf("%s user%d %s", api, user, o.Error))
	}
	return payload, ok
}
func decode[T any](d *driver, p response) (T, bool) {
	var v T
	if e := json.Unmarshal(p.Data, &v); e != nil {
		d.failure("data decode: " + e.Error())
		return v, false
	}
	return v, true
}
func sameJSON(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	aa, _ := json.Marshal(x)
	bb, _ := json.Marshal(y)
	return bytes.Equal(aa, bb)
}
func pauseUntil(deadline time.Time, duration time.Duration) bool {
	left := time.Until(deadline)
	if left <= 0 {
		return false
	}
	if duration > left {
		time.Sleep(left)
		return false
	}
	time.Sleep(duration)
	return true
}

func (d *driver) canvasSave(i int, f fixture, scenario string, c *model.CanvasProject, seq int) {
	var old map[string]any
	json.Unmarshal(c.Document, &old)
	nodes, _ := old["nodes"].([]any)
	content := canvasDocument(f.UID, len(nodes), seq)
	title := fmt.Sprintf("load-%d-edit-%d", i, seq)
	p, ok := d.request(i, f.UID, scenario, "Canvas PUT", "PUT", "/api/v1/canvas/projects/"+c.ID, map[string]any{"revision": c.Revision, "title": title, "document": json.RawMessage(content)}, "")
	if !ok {
		return
	}
	next, ok := decode[model.CanvasProject](d, p)
	if !ok {
		return
	}
	if next.Revision != c.Revision+1 || next.Title != title || !sameJSON(next.Document, content) {
		d.failure("canvas save returned wrong revision/document")
	}
	*c = next
}
func (d *driver) workflowSave(i int, f fixture, scenario string, w *model.Workflow, seq int) {
	g := w.Graph
	g.Nodes = append([]model.WorkflowNode(nil), g.Nodes...)
	g.Nodes[0].Position.X = float64(seq)
	g.Nodes[0].Text = fmt.Sprintf("压测提示词-%d-%d", i, seq)
	name := fmt.Sprintf("load-flow-%d-edit-%d", i, seq)
	p, ok := d.request(i, f.UID, scenario, "Workflow PUT", "PUT", "/api/v1/workflows/"+w.ID, map[string]any{"revision": w.Revision, "name": name, "graph": g}, "")
	if !ok {
		return
	}
	next, ok := decode[model.Workflow](d, p)
	if !ok {
		return
	}
	a, _ := json.Marshal(g)
	b, _ := json.Marshal(next.Graph)
	if next.Revision != w.Revision+1 || next.Name != name || !sameJSON(a, b) {
		d.failure("workflow save returned wrong revision/graph")
	}
	*w = next
}

func (d *driver) virtualUser(i int, f fixture, begin, end time.Time) {
	time.Sleep(time.Until(begin))
	active := d.active.Add(1)
	defer d.active.Add(-1)
	for old := d.peak.Load(); active > old; old = d.peak.Load() {
		if d.peak.CompareAndSwap(old, active) {
			break
		}
	}
	rng := rand.New(rand.NewSource(int64(1000 + i)))
	scenario := "browse"
	if i%10 >= 5 && i%10 <= 7 {
		scenario = "canvas_edit"
	}
	if i%10 >= 8 {
		scenario = "workflow"
	}
	d.request(i, f.UID, scenario, "Session", "GET", "/api/session", nil, "")
	cp, ok := d.request(i, f.UID, scenario, "Canvas GET", "GET", "/api/v1/canvas/projects/"+f.CanvasIDs[i%3], nil, "")
	if !ok {
		return
	}
	c, ok := decode[model.CanvasProject](d, cp)
	if !ok {
		return
	}
	wp, ok := d.request(i, f.UID, scenario, "Workflow GET", "GET", "/api/v1/workflows/"+f.WorkflowID, nil, "")
	if !ok {
		return
	}
	w, ok := decode[model.Workflow](d, wp)
	if !ok {
		return
	}
	lastSession, lastRun := time.Now(), time.Now().Add(-time.Minute)
	runID := f.RunID
	for seq := 1; time.Now().Before(end); seq++ {
		if time.Since(lastSession) > 30*time.Second {
			d.request(i, f.UID, scenario, "Session", "GET", "/api/session", nil, "")
			lastSession = time.Now()
		}
		switch scenario {
		case "browse":
			d.request(i, f.UID, scenario, "Canvas list", "GET", "/api/v1/canvas/projects", nil, "")
			d.request(i, f.UID, scenario, "Canvas GET", "GET", "/api/v1/canvas/projects/"+c.ID, nil, "")
			d.request(i, f.UID, scenario, "Asset list", "GET", "/api/v1/private-images", nil, "")
			d.request(i, f.UID, scenario, "Folder list", "GET", "/api/v1/private-folders", nil, "")
			d.request(i, f.UID, scenario, "Workflow list", "GET", "/api/v1/workflows?page=1&pageSize=20", nil, "")
			d.request(i, f.UID, scenario, "Workflow GET", "GET", "/api/v1/workflows/"+w.ID, nil, "")
			if seq%3 == 0 {
				d.canvasSave(i, f, scenario, &c, seq)
			}
			if seq%6 == 0 {
				d.workflowSave(i, f, scenario, &w, seq)
			}
		case "canvas_edit":
			d.canvasSave(i, f, scenario, &c, seq)
			if seq%5 == 0 {
				d.request(i, f.UID, scenario, "Asset list", "GET", "/api/v1/private-images", nil, "")
			}
		case "workflow":
			d.request(i, f.UID, scenario, "Workflow GET", "GET", "/api/v1/workflows/"+w.ID, nil, "")
			d.workflowSave(i, f, scenario, &w, seq)
			d.request(i, f.UID, scenario, "Workflow Run list", "GET", "/api/v1/workflow-runs?page=1&pageSize=20", nil, "")
			// At most one new fake run per user per minute; fake provider throughput is not the target.
			if time.Since(lastRun) >= time.Minute {
				p, ok := d.request(i, f.UID, scenario, "Workflow Run create", "POST", "/api/v1/workflows/"+w.ID+"/runs", map[string]any{"requestId": uuid.NewString(), "revision": w.Revision}, "")
				if ok {
					var r struct {
						Run model.WorkflowRun `json:"run"`
					}
					json.Unmarshal(p.Data, &r)
					runID = r.Run.ID
				}
				lastRun = time.Now()
			}
		}
		d.request(i, f.UID, scenario, "Workflow Run poll", "GET", "/api/v1/workflow-runs/"+runID, nil, "")
		if !pauseUntil(end, time.Duration(2000+rng.Intn(3001))*time.Millisecond) {
			break
		}
	}
	// Fresh reads must agree with the most recently acknowledged complete documents.
	p, ok := d.request(i, f.UID, "verify", "Canvas verify", "GET", "/api/v1/canvas/projects/"+c.ID, nil, "")
	if ok {
		v, valid := decode[model.CanvasProject](d, p)
		if valid && (v.Revision != c.Revision || v.Title != c.Title || !sameJSON(v.Document, c.Document)) {
			d.failure("persisted canvas mismatch")
		}
	}
	p, ok = d.request(i, f.UID, "verify", "Workflow verify", "GET", "/api/v1/workflows/"+w.ID, nil, "")
	if ok {
		v, valid := decode[model.Workflow](d, p)
		a, _ := json.Marshal(v.Graph)
		b, _ := json.Marshal(w.Graph)
		if valid && (v.Revision != w.Revision || v.Name != w.Name || !sameJSON(a, b)) {
			d.failure("persisted workflow mismatch")
		}
	}
}

func (d *driver) conflicts(f fixture, rounds int) {
	id := "conflict-" + uuid.NewString()
	p, ok := d.request(-1, f.UID, "conflict", "Conflict seed", "POST", "/api/v1/canvas/projects", map[string]any{"id": id, "title": "race", "document": canvasDocument(f.UID, 30, 0)}, "")
	if !ok {
		return
	}
	c, ok := decode[model.CanvasProject](d, p)
	if !ok {
		return
	}
	for n := 0; n < rounds; n++ {
		var payloads [2]response
		var oks [2]bool
		var wg sync.WaitGroup
		ready := make(chan struct{})
		for a := 0; a < 2; a++ {
			wg.Add(1)
			go func(a int) {
				defer wg.Done()
				<-ready
				payloads[a], oks[a] = d.request(-1-a, f.UID, "conflict", "Canvas conflict PUT", "PUT", "/api/v1/canvas/projects/"+id, map[string]any{"revision": c.Revision, "title": fmt.Sprintf("writer-%d-round-%d", a, n), "document": canvasDocument(f.UID, 30, n*2+a+1)}, "race")
			}(a)
		}
		close(ready)
		wg.Wait()
		wins := 0
		var winner model.CanvasProject
		for a := 0; a < 2; a++ {
			if oks[a] && payloads[a].Code == 0 {
				wins++
				winner, _ = decode[model.CanvasProject](d, payloads[a])
			}
		}
		if wins != 1 || !oks[0] || !oks[1] || winner.Revision != c.Revision+1 {
			d.failure("conflict: expected exactly one winner and one 409")
		}
		p, ok := d.request(-1, f.UID, "conflict", "Conflict verify", "GET", "/api/v1/canvas/projects/"+id, nil, "")
		if !ok {
			return
		}
		v, _ := decode[model.CanvasProject](d, p)
		if v.Revision != winner.Revision || v.Title != winner.Title || !sameJSON(v.Document, winner.Document) {
			d.failure("conflict: stale data silently overwrote winner")
		}
		c = v
		time.Sleep(time.Second)
	}
}

func drive(path, out string, users int, ramp, hold, down time.Duration) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var m manifest
	if err = json.Unmarshal(raw, &m); err != nil {
		return err
	}
	u, err := url.Parse(m.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || len(m.Users) != 50 {
		return fmt.Errorf("refuse non-local or invalid manifest")
	}
	for _, f := range m.Users {
		if !strings.HasPrefix(f.UID, "load-user-") {
			return fmt.Errorf("refuse non-test account")
		}
	}
	f, err := os.Create(filepath.Join(out, "requests.ndjson"))
	if err != nil {
		return err
	}
	defer f.Close()
	buffer := bufio.NewWriter(f)
	defer buffer.Flush()
	transport := &http.Transport{MaxIdleConns: 150, MaxIdleConnsPerHost: 100, MaxConnsPerHost: 150, IdleConnTimeout: 30 * time.Second, Proxy: nil}
	defer transport.CloseIdleConnections()
	d := &driver{base: m.URL, client: &http.Client{Transport: transport}, start: time.Now().Add(time.Hour), ramp: ramp, hold: hold, down: down, events: json.NewEncoder(buffer)}
	d.request(-1, "", "permission", "Session unauthenticated", "GET", "/api/session", nil, "401")
	d.request(-1, m.Users[0].UID, "permission", "Admin forbidden", "GET", "/api/admin/settings", nil, "403")
	d.request(-1, m.Users[0].UID, "permission", "Foreign Canvas", "GET", "/api/v1/canvas/projects/"+m.Users[1].CanvasIDs[0], nil, "denied")
	d.request(-1, m.Users[0].UID, "permission", "Foreign Workflow", "GET", "/api/v1/workflows/"+m.Users[1].WorkflowID, nil, "denied")
	d.request(-1, m.Users[0].UID, "permission", "Foreign Run", "GET", "/api/v1/workflow-runs/"+m.Users[1].RunID, nil, "denied")
	d.start = time.Now().Add(time.Second)
	if err := writeJSON(filepath.Join(out, "stage.json"), map[string]any{"users": users, "start": d.start, "ramp_seconds": ramp.Seconds(), "hold_seconds": hold.Seconds(), "down_seconds": down.Seconds(), "scenario_ratio": "50/30/20", "seed": 1000}); err != nil {
		return err
	}
	metrics, err := os.Create(filepath.Join(out, "metrics.ndjson"))
	if err != nil {
		return err
	}
	defer metrics.Close()
	encoder := json.NewEncoder(metrics)
	monitorCtx, stopMonitor := context.WithCancel(context.Background())
	var monitor sync.WaitGroup
	monitor.Add(1)
	go func() {
		defer monitor.Done()
		for {
			reqCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			req, _ := http.NewRequestWithContext(reqCtx, "GET", m.URL+"/__loadtest/metrics", nil)
			res, e := d.client.Do(req)
			if e == nil {
				var sample map[string]any
				e = json.NewDecoder(res.Body).Decode(&sample)
				res.Body.Close()
				if e == nil {
					sample["active_users"] = d.active.Load()
					sample["phase"] = d.phase()
					encoder.Encode(sample)
				}
			}
			cancel()
			if e != nil {
				d.failure("metrics: " + e.Error())
			}
			select {
			case <-monitorCtx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}()
	var wg sync.WaitGroup
	for i := 0; i < users; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			begin := d.start.Add(time.Duration(float64(ramp) * float64(i) / float64(users)))
			end := d.start.Add(ramp + hold + time.Duration(float64(down)*float64(i+1)/float64(users)))
			d.virtualUser(i, m.Users[i], begin, end)
		}(i)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(time.Until(d.start.Add(ramp + hold/2)))
		d.conflicts(m.Users[0], 10)
	}()
	wg.Wait()
	time.Sleep(10 * time.Second)
	stopMonitor()
	monitor.Wait()
	summary := map[string]any{"users": users, "peak_users": d.peak.Load(), "requests": d.requests.Load(), "assertion_failures": d.failures, "end": time.Now().UTC()}
	if err := writeJSON(filepath.Join(out, "checks.json"), summary); err != nil {
		return err
	}
	fmt.Printf("users=%d peak=%d requests=%d assertion_failures=%d\n", users, d.peak.Load(), d.requests.Load(), len(d.failures))
	if len(d.failures) > 0 {
		return fmt.Errorf("load test assertions failed; see checks.json")
	}
	return nil
}
