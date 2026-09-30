package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/gin-gonic/gin"
)

func signedIdentityRequest(secret string, issuedAt int64) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/private", nil)
	r.Header.Set("X-Portal-User-Id", "12")
	r.Header.Set("X-Portal-User-Uid", "2b5892c4-3dd2-4f82-8644-f0d14a0b5e71")
	r.Header.Set("X-Portal-Username", "%E5%BC%A0%E4%B8%89")
	r.Header.Set("X-Portal-Roles", "member,portal-admin")
	r.Header.Set("X-Portal-Identity-Time", strconv.FormatInt(issuedAt, 10))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join([]string{"portal.identity.v1", "infinite-canvas", "12", r.Header.Get("X-Portal-User-Uid"), r.Header.Get("X-Portal-Username"), r.Header.Get("X-Portal-Roles"), r.Header.Get("X-Portal-Identity-Time")}, "\n")))
	r.Header.Set("X-Portal-Identity-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	return r
}

func TestPortalIdentitySignatureBoundary(t *testing.T) {
	previous := config.Cfg
	config.Cfg.PortalDirectoryAppKey = "infinite-canvas"
	config.Cfg.PortalDirectorySecret = "test-identity-secret"
	t.Cleanup(func() { config.Cfg = previous })
	router := gin.New()
	router.Use(PortalIdentity)
	router.GET("/private", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	tests := []struct {
		name   string
		mutate func(*http.Request)
		status int
	}{
		{"valid", func(r *http.Request) {}, 204},
		{"missing signature", func(r *http.Request) { r.Header.Del("X-Portal-Identity-Signature") }, 401},
		{"wrong secret", func(r *http.Request) {
			r.Header.Set("X-Portal-Identity-Signature", signedIdentityRequest("wrong", time.Now().Unix()).Header.Get("X-Portal-Identity-Signature"))
		}, 401},
		{"tampered roles", func(r *http.Request) { r.Header.Set("X-Portal-Roles", "portal-admin") }, 401},
		{"tampered UID", func(r *http.Request) { r.Header.Set("X-Portal-User-Uid", "1b5892c4-3dd2-4f82-8644-f0d14a0b5e71") }, 401},
		{"expired", func(r *http.Request) { *r = *signedIdentityRequest("test-identity-secret", time.Now().Unix()-60) }, 401},
		{"future", func(r *http.Request) { *r = *signedIdentityRequest("test-identity-secret", time.Now().Unix()+10) }, 401},
		{"rotation", func(r *http.Request) {
			r.Header.Set("X-Portal-Identity-Signature", signedIdentityRequest("old", time.Now().Unix()).Header.Get("X-Portal-Identity-Signature")+","+r.Header.Get("X-Portal-Identity-Signature"))
		}, 204},
		{"duplicate UID", func(r *http.Request) { r.Header.Add("X-Portal-User-Uid", r.Header.Get("X-Portal-User-Uid")) }, 401},
		{"missing user ID", func(r *http.Request) { r.Header.Del("X-Portal-User-Id") }, 401},
		{"invalid base64", func(r *http.Request) { r.Header.Set("X-Portal-Identity-Signature", strings.Repeat("!", 43)) }, 401},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := signedIdentityRequest("test-identity-secret", time.Now().Unix())
			tt.mutate(r)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != tt.status {
				t.Fatalf("status=%d body=%s want=%d", w.Code, w.Body.String(), tt.status)
			}
			if tt.status == 401 && !strings.Contains(w.Body.String(), "PORTAL_IDENTITY_INVALID") {
				t.Fatal(w.Body.String())
			}
		})
	}
}

// Fixed vector generated and verified with Portal's examples/portal-identity.mjs.
// It detects protocol drift (encoding, field order, app binding and newline rules).
func TestPortalIdentityInteroperatesWithPortalExample(t *testing.T) {
	headers := http.Header{
		"X-Portal-User-Id":            {"42"},
		"X-Portal-User-Uid":           {"93f6e9cc-7f95-4c14-b9eb-cf4ebd4373ac"},
		"X-Portal-Username":           {"%E4%B8%AD%E6%96%87%20%2B%20%E7%94%A8%E6%88%B7"},
		"X-Portal-Roles":              {"portal-admin,%E8%AE%BE%E8%AE%A1%2C%E8%A7%92%E8%89%B2"},
		"X-Portal-Identity-Time":      {"1780000000"},
		"X-Portal-Identity-Signature": {"1a_AvT7DuOtOt_KnXEZyWsz2XD2VL18AwzQxYLG2aQo"},
	}
	user, valid := verifyPortalIdentity(headers, "infinite-canvas", "interop-fixture-only", time.Unix(1780000000, 0))
	if !valid || user.UID != "93f6e9cc-7f95-4c14-b9eb-cf4ebd4373ac" || user.Username != "中文 + 用户" || len(user.Roles) != 2 || user.Roles[1] != "设计,角色" {
		t.Fatalf("decoded identity=%+v valid=%t", user, valid)
	}
	if _, valid := verifyPortalIdentity(headers, "other-app", "interop-fixture-only", time.Unix(1780000000, 0)); valid {
		t.Fatal("signature issued for another app was accepted")
	}
	if _, valid := verifyPortalIdentity(headers, "infinite-canvas", "interop-fixture-only", time.Unix(1780000060, 0)); valid {
		t.Fatal("identity was accepted at expiry boundary")
	}
}

func TestPortalIdentityOptionalRolesAndDecodeFailures(t *testing.T) {
	const secret = "test-identity-secret"
	now := time.Unix(1780000000, 0)
	for _, test := range []struct {
		name, username, roles string
		omitRoles, wantValid  bool
	}{
		{name: "missing roles", username: "alice", omitRoles: true, wantValid: true},
		{name: "empty roles", username: "alice", wantValid: true},
		{name: "invalid UTF8 name", username: "%FF"},
		{name: "invalid escape", username: "%ZZ"},
		{name: "invalid UTF8 role", username: "alice", roles: "%FF"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := signedIdentityRequest(secret, now.Unix()+5)
			request.Header.Set("X-Portal-Username", test.username)
			request.Header.Set("X-Portal-Roles", test.roles)
			if test.omitRoles {
				request.Header.Del("X-Portal-Roles")
			}
			mac := hmac.New(sha256.New, []byte(secret))
			mac.Write([]byte(strings.Join([]string{"portal.identity.v1", "infinite-canvas", request.Header.Get("X-Portal-User-Id"), request.Header.Get("X-Portal-User-Uid"), test.username, test.roles, request.Header.Get("X-Portal-Identity-Time")}, "\n")))
			request.Header.Set("X-Portal-Identity-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
			user, valid := verifyPortalIdentity(request.Header, "infinite-canvas", secret, now)
			if valid != test.wantValid {
				t.Fatalf("valid=%t want=%t", valid, test.wantValid)
			}
			if valid && len(user.Roles) != 0 {
				t.Fatalf("roles=%v", user.Roles)
			}
		})
	}
}
