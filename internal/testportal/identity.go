// Package testportal builds signed Gateway requests for isolated API tests.
package testportal

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// SyntheticUID keeps named isolated fixtures readable while their identities
// obey the Gateway UUID contract. Sign never rewrites identity inputs.
func SyntheticUID(label string) string {
	if label == "" {
		return ""
	}
	if parsed, err := uuid.Parse(label); err == nil {
		return parsed.String()
	}
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("infinite-canvas.test/"+label)).String()
}

func Sign(r *http.Request, appKey, secret string) {
	if r.Header.Get("X-Portal-User-Uid") == "" {
		return
	}
	if r.Header.Get("X-Portal-User-Id") == "" {
		r.Header.Set("X-Portal-User-Id", "1")
	}
	if r.Header.Get("X-Portal-Username") == "" {
		r.Header.Set("X-Portal-Username", "test-user")
	}
	r.Header.Set("X-Portal-Identity-Time", strconv.FormatInt(time.Now().Unix(), 10))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join([]string{"portal.identity.v1", appKey, r.Header.Get("X-Portal-User-Id"), r.Header.Get("X-Portal-User-Uid"), r.Header.Get("X-Portal-Username"), r.Header.Get("X-Portal-Roles"), r.Header.Get("X-Portal-Identity-Time")}, "\n")))
	r.Header.Set("X-Portal-Identity-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
}
