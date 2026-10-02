package middleware

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
)

const boundarySecret = "PUBLIC_TEST_ONLY_portal_identity_vector_secret"
const boundaryApp = "vector-app"
const boundaryUpper = "ABCDEFAB-2222-4333-8444-555555555555"

func TestPortalUUIDShapeAndRawSigningOrder(t *testing.T) {
	now := time.Unix(1790000000, 0)
	for _, uid := range []string{boundaryUpper, strings.ToLower(boundaryUpper), "00000000-0000-0000-0000-000000000000", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"} {
		user, valid, reason := verifyPortalIdentityWithReason(boundaryHeaders(uid, "", now.Unix()), boundaryApp, boundarySecret, now)
		if !valid || user.UID != strings.ToLower(uid) {
			t.Fatalf("allowed UUID shape rejected: %q valid%t reason%s", uid, valid, reason)
		}
	}
	for _, uid := range []string{"not-a-uuid", "abcdefab222243338444555555555555", "{abcdefab-2222-4333-8444-555555555555}", "urn:uuid:abcdefab-2222-4333-8444-555555555555", " " + boundaryUpper, boundaryUpper + "\n"} {
		// Separate synthetic HMACs prove format rejection even with a matching
		// signature; official fixed vectors are never re-signed or modified.
		_, valid, reason := verifyPortalIdentityWithReason(boundaryHeaders(uid, "", now.Unix()), boundaryApp, boundarySecret, now)
		if valid || reason != "malformed" {
			t.Fatalf("invalid UUID accepted: valid%t reason%s", valid, reason)
		}
	}
	headers := boundaryHeaders(boundaryUpper, "", now.Unix())
	headers.Set("X-Portal-User-Uid", strings.ToLower(boundaryUpper))
	if _, valid, reason := verifyPortalIdentityWithReason(headers, boundaryApp, boundarySecret, now); valid || reason != "mismatch" {
		t.Fatalf("raw UID case not bound: valid%t reason%s", valid, reason)
	}
	headers = boundaryHeaders(strings.ToLower(boundaryUpper), "", now.Unix())
	headers.Set("X-Portal-User-Id", "8")
	if _, valid, reason := verifyPortalIdentityWithReason(headers, boundaryApp, boundarySecret, now); valid || reason != "mismatch" {
		t.Fatalf("numeric ID not bound: valid%t reason%s", valid, reason)
	}
}

func TestPortalCanonicalIdentityKeepsStoredRolesAndOwnership(t *testing.T) {
	now := time.Unix(1790000000, 0)
	uid := fixtureUID("canonical-protocol-owner")
	if err := repository.UpsertPortalMembers([]model.PortalMember{{UserUID: uid, DisplayName: "synthetic canonical owner", Enabled: true, Roles: []string{}}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetAppRole(uid, model.AppRolePublicAssetsManager, "", false); err != nil {
		t.Fatal(err)
	}
	project, _, err := repository.CreateCanvasProject(model.CanvasProject{ID: "canonical-protocol-board", OwnerUID: uid, Title: "synthetic canonical board", Document: model.CanvasProjectDocument(`{"nodes":[],"connections":[]}`), Revision: 1})
	if err != nil {
		t.Fatal(err)
	}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	audit := model.OperationLog{ID: "canonical-protocol-maintenance", ActorUID: "system", ActorName: "maintenance fixture", Action: "media_cleanup", Status: model.OperationStatusSuccess}
	if err := repository.SaveOperationLog(audit); err != nil {
		t.Fatal(err)
	}
	var roleBefore model.AppMemberRole
	if err := db.Where("user_uid = ?", uid).First(&roleBefore).Error; err != nil {
		t.Fatal(err)
	}
	memberBefore, found, err := repository.GetPortalMember(uid)
	if err != nil || !found {
		t.Fatal("synthetic member missing", err)
	}
	for _, raw := range []string{uid, strings.ToUpper(uid)} {
		user, valid, reason := verifyPortalIdentityWithReason(boundaryHeaders(raw, "", now.Unix()), boundaryApp, boundarySecret, now)
		if !valid || user.UID != uid {
			t.Fatalf("canonical identity: %t %s", valid, reason)
		}
		permissions, err := service.ResolveAppPermissions(context.Background(), user)
		if err != nil || permissions.AppRole != model.AppRolePublicAssetsManager || !permissions.CanManagePublicAssets || permissions.IsAdmin {
			t.Fatalf("existing role changed: %+v %v", permissions, err)
		}
		actual, found, err := repository.GetCanvasProject(user.UID, project.ID)
		if err != nil || !found || !reflect.DeepEqual(actual, project) {
			t.Fatalf("existing ownership changed: %+v %v", actual, err)
		}
	}
	other := fixtureUID("canonical-protocol-other")
	user, valid, reason := verifyPortalIdentityWithReason(boundaryHeaders(other, "", now.Unix()), boundaryApp, boundarySecret, now)
	if !valid {
		t.Fatal(reason)
	}
	if _, found, err := repository.GetCanvasProject(user.UID, project.ID); err != nil || found {
		t.Fatal("different UUID crossed owner boundary", err)
	}
	permissions, err := service.ResolveAppPermissions(context.Background(), user)
	if err != nil || permissions.AppRole != model.AppRoleMember {
		t.Fatal("unsynchronized member gained a role", err)
	}
	forged := boundaryHeaders(other, "", now.Unix())
	forged.Set("X-Portal-Roles", "portal-admin")
	if _, valid, reason := verifyPortalIdentityWithReason(forged, boundaryApp, boundarySecret, now); valid || reason != "mismatch" {
		t.Fatal("unsigned role change gained authority")
	}
	memberAfter, _, err := repository.GetPortalMember(uid)
	if err != nil || !reflect.DeepEqual(memberBefore, memberAfter) {
		t.Fatal("verification changed member data", err)
	}
	var roleAfter model.AppMemberRole
	if err := db.Where("user_uid = ?", uid).First(&roleAfter).Error; err != nil || !reflect.DeepEqual(roleBefore, roleAfter) {
		t.Fatal("verification changed role or empty grantor", err)
	}
	var auditAfter model.OperationLog
	if err := db.Where("id = ?", audit.ID).First(&auditAfter).Error; err != nil || auditAfter.ActorUID != audit.ActorUID {
		t.Fatal("verification changed maintenance audit", err)
	}
}

func boundaryHeaders(uid, roles string, now int64) http.Header {
	h := http.Header{}
	h.Set("X-Portal-User-Id", "7")
	h.Set("X-Portal-User-Uid", uid)
	h.Set("X-Portal-Username", "Synthetic%20boundary")
	h.Set("X-Portal-Roles", roles)
	h.Set("X-Portal-Identity-Time", strconv.FormatInt(now, 10))
	mac := hmac.New(sha256.New, []byte(boundarySecret))
	mac.Write([]byte(strings.Join([]string{"portal.identity.v1", boundaryApp, "7", uid, h.Get("X-Portal-Username"), roles, h.Get("X-Portal-Identity-Time")}, "\n")))
	h.Set("X-Portal-Identity-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	return h
}

func TestPortalIdentityRealHTTPWireHeaders(t *testing.T) {
	previous := config.Cfg
	config.Cfg.PortalDirectoryAppKey = boundaryApp
	config.Cfg.PortalDirectorySecret = boundarySecret
	t.Cleanup(func() { config.Cfg = previous })
	gin.SetMode(gin.TestMode)
	type observation struct {
		RoleValues []string `json:"roleValues"`
		UIDValues  []string `json:"uidValues"`
		Valid      bool     `json:"actualVerifierOK"`
		Reason     string   `json:"actualVerifierReason"`
	}
	observed := make(chan observation, 1)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		_, ok, reason := verifyPortalIdentityWithReason(c.Request.Header, boundaryApp, boundarySecret, time.Now())
		observed <- observation{c.Request.Header.Values("X-Portal-Roles"), c.Request.Header.Values("X-Portal-User-Uid"), ok, reason}
		c.Next()
	}, PortalIdentity)
	router.GET("/private", func(c *gin.Context) {
		u, ok := service.PortalUserFromContext(c.Request.Context())
		if !ok {
			c.Status(500)
			return
		}
		c.JSON(200, u)
	})
	server := httptest.NewServer(router)
	defer server.Close()
	specs := []struct {
		name, roles, mode string
		status            int
		reason            string
	}{
		{"one-header", "member", "single", 200, ""},
		{"duplicate-role-lines", "member", "duplicate", 401, "malformed"},
		{"mixed-case-duplicate-role-lines", "member", "mixed-duplicate", 401, "malformed"},
		{"duplicate-empty-role-lines", "", "duplicate", 401, "malformed"},
		{"empty-roles", "", "single", 200, ""},
		{"absent-roles-signed-empty", "", "missing", 200, ""},
		{"absent-roles-signed-nonempty", "member", "missing", 401, "mismatch"},
		{"malformed-role-list", "member", "malformed", 401, "malformed"},
		{"duplicate-uid-lines", "member", "duplicate-uid", 401, "malformed"},
		{"mixed-case-header-names", "member", "mixed-name", 200, ""},
		{"malformed-uid-correct-signature", "member", "malformed-uid", 401, "malformed"},
		{"compact-uid-correct-signature", "member", "compact-uid", 401, "malformed"},
		{"uppercase-uid-correct-signature", "member", "uppercase-uid", 200, ""},
	}
	rows := []map[string]any{}
	for _, spec := range specs {
		h := boundaryHeaders(strings.ToLower(boundaryUpper), spec.roles, time.Now().Unix())
		if spec.mode == "malformed-uid" {
			h = boundaryHeaders("not-a-uuid", spec.roles, time.Now().Unix())
		}
		if spec.mode == "compact-uid" {
			h = boundaryHeaders(strings.ReplaceAll(boundaryUpper, "-", ""), spec.roles, time.Now().Unix())
		}
		if spec.mode == "uppercase-uid" {
			h = boundaryHeaders(boundaryUpper, spec.roles, time.Now().Unix())
		}
		conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		var request strings.Builder
		request.WriteString("GET /private HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n")
		for name, values := range h {
			value := values[0]
			if name == "X-Portal-Roles" && spec.mode == "missing" {
				continue
			}
			if name == "X-Portal-Roles" && spec.mode == "malformed" {
				value = "a,,b"
			}
			wireName := name
			if spec.mode == "mixed-name" {
				wireName = strings.ToLower(name)
			}
			fmt.Fprintf(&request, "%s: %s\r\n", wireName, value)
			if (name == "X-Portal-Roles" && (spec.mode == "duplicate" || spec.mode == "mixed-duplicate")) || (name == "X-Portal-User-Uid" && spec.mode == "duplicate-uid") {
				if spec.mode == "mixed-duplicate" {
					wireName = strings.ToLower(name)
				}
				fmt.Fprintf(&request, "%s: %s\r\n", wireName, value)
			}
		}
		request.WriteString("\r\n")
		if _, err := io.WriteString(conn, request.String()); err != nil {
			t.Fatal(err)
		}
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		conn.Close()
		if err != nil {
			t.Fatal(err)
		}
		actual := <-observed
		if response.StatusCode != spec.status || actual.Reason != spec.reason || actual.Valid != (spec.status == 200) {
			t.Fatalf("%s: %+v status%d", spec.name, actual, response.StatusCode)
		}
		if spec.status == 401 && (!strings.Contains(string(body), "PORTAL_IDENTITY_INVALID") || strings.Contains(string(body), spec.reason)) {
			t.Fatalf("failure details leaked in %s", spec.name)
		}
		if spec.mode == "uppercase-uid" && (!strings.Contains(string(body), strings.ToLower(boundaryUpper)) || strings.Contains(string(body), boundaryUpper)) {
			t.Fatal("wire identity did not canonicalize after authentication")
		}
		rows = append(rows, map[string]any{"name": spec.name, "actualStatus": response.StatusCode, "observation": actual, "externalErrorGeneric": spec.status != 401 || strings.Contains(string(body), "PORTAL_IDENTITY_INVALID")})
	}
	scalar := http.Header{}
	scalar.Set("X-Portal-Roles", "member")
	array := http.Header{"X-Portal-Roles": []string{"member"}}
	if !reflect.DeepEqual(scalar, array) {
		t.Fatal("expected single-array/scalar representational collision absent")
	}
	t.Logf("%d real HTTP wire cases passed; normal single-value and duplicate-field semantics preserved", len(rows))
}
