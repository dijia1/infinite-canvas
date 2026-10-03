package middleware

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/textproto"
	"os"
	"reflect"
	"strconv"
	"testing"
	"time"
)

// Exact public fixture from Portal 3925a9dc101a3928e5e590047b0b3c7a3be729db.
const portalVectorSHA256 = "e5203003723a6d442c7ff1ddc9336efb70ef3cd6a8cde5eb6247b115468f8fc3"
const portalVectorTypeBoundary = "array-header-roles"

type portalVectorIdentity struct {
	UserID   int64    `json:"userId"`
	UserUID  string   `json:"userUid"`
	Username string   `json:"username"`
	Roles    []string `json:"roles"`
}

type portalIdentityVector struct {
	Name            string                     `json:"name"`
	Headers         map[string]json.RawMessage `json:"headers"`
	AppKey          *string                    `json:"appKey"`
	Secret          *string                    `json:"secret"`
	Now             *int64                     `json:"now"`
	NowMilliseconds *int64                     `json:"nowMilliseconds"`
	Expect          struct {
		OK       bool                 `json:"ok"`
		Identity portalVectorIdentity `json:"identity"`
		Reason   string               `json:"reason"`
	} `json:"expect"`
}

type portalVectorFixture struct {
	FormatVersion int                    `json:"formatVersion"`
	Protocol      string                 `json:"protocol"`
	AppKey        string                 `json:"appKey"`
	Secret        string                 `json:"secret"`
	Now           int64                  `json:"now"`
	Cases         []portalIdentityVector `json:"cases"`
}

func loadPortalVectors(t *testing.T) portalVectorFixture {
	t.Helper()
	blob, err := os.ReadFile("../examples/portal-identity.vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(blob)
	if hex.EncodeToString(hash[:]) != portalVectorSHA256 {
		t.Fatal("official fixture bytes changed")
	}
	var fixture portalVectorFixture
	if err := json.Unmarshal(blob, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.FormatVersion != 1 || fixture.Protocol != "portal.identity.v1" || len(fixture.Cases) != 56 {
		t.Fatal("official fixture contract changed")
	}
	return fixture
}

// Preserve JSON types until deciding whether a faithful native mapping exists.
// A one-element JS array is indistinguishable from a normal scalar in Go Header.
func nativePortalVectorHeaders(t *testing.T, vector portalIdentityVector) (http.Header, bool) {
	t.Helper()
	headers := http.Header{}
	unrepresentable := false
	for key, raw := range vector.Headers {
		name := textproto.CanonicalMIMEHeaderKey(key)
		var scalar string
		if err := json.Unmarshal(raw, &scalar); err == nil {
			headers[name] = []string{scalar}
			continue
		}
		var values []string
		if err := json.Unmarshal(raw, &values); err != nil {
			t.Fatalf("unexpected fixture header type: %s/%s", vector.Name, key)
		}
		if len(values) == 1 {
			if vector.Name != portalVectorTypeBoundary || key != "x-portal-roles" {
				t.Fatalf("new unrepresentable input needs explicit review: %s/%s", vector.Name, key)
			}
			unrepresentable = true
		}
		headers[name] = values
	}
	return headers, !unrepresentable
}

func TestPortalOfficialIdentityVectorsNativeRuntime(t *testing.T) {
	fixture := loadPortalVectors(t)
	seen := map[string]bool{}
	native, positive, negative, notApplicable := 0, 0, 0, 0
	for _, vector := range fixture.Cases {
		if seen[vector.Name] {
			t.Fatal("duplicate official case name", vector.Name)
		}
		seen[vector.Name] = true
		headers, representable := nativePortalVectorHeaders(t, vector)
		if !representable {
			notApplicable++
			continue
		}
		native++
		if vector.Expect.OK {
			positive++
		} else {
			negative++
		}
		t.Run(vector.Name, func(t *testing.T) {
			appKey, secret, now := fixture.AppKey, fixture.Secret, time.Unix(fixture.Now, 0)
			if vector.AppKey != nil {
				appKey = *vector.AppKey
			}
			if vector.Secret != nil {
				secret = *vector.Secret
			}
			if vector.Now != nil {
				now = time.Unix(*vector.Now, 0)
			}
			if vector.NowMilliseconds != nil {
				now = time.UnixMilli(*vector.NowMilliseconds)
			}
			user, valid, reason := verifyPortalIdentityWithReason(headers, appKey, secret, now)
			if valid != vector.Expect.OK {
				t.Fatalf("actual acceptance=%t reason=%s", valid, reason)
			}
			if !valid {
				if reason != vector.Expect.Reason {
					t.Fatalf("actual reason=%s expected=%s", reason, vector.Expect.Reason)
				}
				return
			}
			// The real verifier returns UID/name/roles, not numeric userId. Project
			// this bound field only after successful verification; never normalize
			// the real return values in tests to hide protocol differences.
			id, err := strconv.ParseInt(headers.Get("X-Portal-User-Id"), 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			actual := portalVectorIdentity{UserID: id, UserUID: user.UID, Username: user.Username, Roles: user.Roles}
			if !reflect.DeepEqual(actual, vector.Expect.Identity) {
				t.Fatalf("actual authenticated projection=%+v expected=%+v", actual, vector.Expect.Identity)
			}
		})
	}
	if native != 55 || positive != 13 || negative != 42 || notApplicable != 1 {
		t.Fatalf("classification drift: native%d positive%d negative%d N/A%d", native, positive, negative, notApplicable)
	}
	t.Log("official56 classified: native55 (positive13/negative42) + N/A1 JS input type; N/A is not a runtime pass")
}

func TestPortalIdentityJSArrayTypeBoundaryIsNotNativeHTTP(t *testing.T) {
	fixture := loadPortalVectors(t)
	for _, vector := range fixture.Cases {
		if vector.Name != portalVectorTypeBoundary {
			continue
		}
		headers, representable := nativePortalVectorHeaders(t, vector)
		if representable || vector.Expect.OK || vector.Expect.Reason != "malformed" {
			t.Fatal("official JS type boundary changed")
		}
		var roles []string
		if err := json.Unmarshal(vector.Headers["x-portal-roles"], &roles); err != nil || len(roles) != 1 {
			t.Fatal("expected original single-element JS array")
		}
		scalar := headers.Clone()
		scalar.Set("X-Portal-Roles", roles[0])
		if !reflect.DeepEqual(scalar, headers) {
			t.Fatal("expected native representation collision")
		}
		_, valid, reason := verifyPortalIdentityWithReason(scalar, fixture.AppKey, fixture.Secret, time.Unix(fixture.Now, 0))
		if !valid {
			t.Fatalf("normal signed single-value HTTP header rejected: %s", reason)
		}
		t.Log("N/A array-header-roles: JS array type is not expressible as a distinct Go Header; real duplicate wire fields are tested separately")
		return
	}
	t.Fatal("official type boundary missing")
}
