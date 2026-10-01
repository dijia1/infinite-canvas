package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/basketikun/infinite-canvas/service"
)

var portalAppKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
var portalIntegerPattern = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
var portalEncodedPattern = regexp.MustCompile(`^[A-Za-z0-9\-_.!~*'()%]+$`)
var portalSignaturePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// Verify raw values before decoding: Portal signs the seven-line identity with
// this application's service credential. A shared Docker network is not trust.
func verifyPortalIdentity(headers http.Header, appKey, secret string, now time.Time) (service.PortalUser, bool) {
	user, valid, _ := verifyPortalIdentityWithReason(headers, appKey, secret, now)
	return user, valid
}

func verifyPortalIdentityWithReason(headers http.Header, appKey, secret string, now time.Time) (service.PortalUser, bool, string) {
	invalid := service.PortalUser{}
	if !portalAppKeyPattern.MatchString(appKey) || strings.TrimSpace(secret) == "" {
		return invalid, false, "malformed"
	}
	names := []string{"X-Portal-User-Id", "X-Portal-User-Uid", "X-Portal-Username", "X-Portal-Roles", "X-Portal-Identity-Time", "X-Portal-Identity-Signature"}
	values := make([]string, len(names))
	for i, name := range names {
		entries := headers.Values(name)
		if i == 3 && len(entries) == 0 {
			continue
		}
		if len(entries) == 0 {
			return invalid, false, "missing"
		}
		if len(entries) != 1 || (i != 3 && entries[0] == "") {
			return invalid, false, "malformed"
		}
		values[i] = entries[0]
	}
	userID, uid, username, roles, issued, signatures := values[0], values[1], values[2], values[3], values[4], values[5]
	if !portalIntegerPattern.MatchString(userID) || !portalIntegerPattern.MatchString(issued) || strings.TrimSpace(uid) != uid || len(uid) > 128 || strings.ContainsAny(uid, "\r\n") || len(username) > 1024 || !portalEncodedPattern.MatchString(username) || len(roles) > 4096 {
		return invalid, false, "malformed"
	}
	id, err := strconv.ParseInt(userID, 10, 64)
	if err != nil || id > 9007199254740991 {
		return invalid, false, "malformed"
	}
	seconds, err := strconv.ParseInt(issued, 10, 64)
	if err != nil || seconds > 9007199254740991 {
		return invalid, false, "malformed"
	}
	if seconds > now.Unix()+5 || now.Unix() >= seconds+60 {
		return invalid, false, "expired"
	}
	if roles != "" {
		for _, role := range strings.Split(roles, ",") {
			if !portalEncodedPattern.MatchString(role) {
				return invalid, false, "malformed"
			}
		}
	}
	items := strings.Split(signatures, ",")
	if len(items) > 8 {
		return invalid, false, "malformed"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join([]string{"portal.identity.v1", appKey, userID, uid, username, roles, issued}, "\n")))
	expected := mac.Sum(nil)
	matched := false
	for _, item := range items {
		if !portalSignaturePattern.MatchString(item) {
			return invalid, false, "malformed"
		}
		decoded, err := base64.RawURLEncoding.Strict().DecodeString(item)
		if err != nil || len(decoded) != sha256.Size {
			return invalid, false, "malformed"
		}
		equal := hmac.Equal(decoded, expected)
		matched = equal || matched
	}
	if !matched {
		return invalid, false, "mismatch"
	}
	decodedName, err := url.PathUnescape(username)
	if err != nil || !utf8.ValidString(decodedName) {
		return invalid, false, "malformed"
	}
	decodedRoles := make([]string, 0)
	if roles != "" {
		for _, role := range strings.Split(roles, ",") {
			decoded, err := url.PathUnescape(role)
			if err != nil || !utf8.ValidString(decoded) {
				return invalid, false, "malformed"
			}
			decodedRoles = append(decodedRoles, decoded)
		}
	}
	return service.PortalUser{UID: uid, Username: decodedName, Roles: decodedRoles}, true, ""
}
