package service

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
)

func TestOSSRegionalEndpointSignatures(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	const bucket = "endpoint-fixture"
	const key = "images/private/test-owner/中文 空格+图.png"
	const version = "version-id+/="
	const ttl = 15 * time.Minute
	disposition := VideoDownloadDisposition("clip.mp4")

	for _, endpoint := range []string{"https://oss-cn-hongkong.aliyuncs.com", "oss-cn-hongkong.aliyuncs.com"} {
		t.Run(endpoint, func(t *testing.T) {
			config.Cfg = config.Config{
				MediaStorage: "oss", OSSRegion: "cn-hongkong", OSSBucket: bucket,
				OSSInternalEndpoint: "https://internal.example", OSSPublicEndpoint: endpoint,
				OSSAccessKeyID: "test-id", OSSAccessKeySecret: "test-secret", OSSSignedURLTTL: "15m",
			}
			// Exercise production initialization: a bare SDK client would miss the CNAME regression.
			store, err := newImageStore()
			if err != nil {
				t.Fatal(err)
			}
			target := store.(*ossImageStore)
			cases := []struct {
				name, version, process, disposition string
				sign                                func() (string, time.Time, error)
			}{
				{name: "original", sign: func() (string, time.Time, error) {
					return store.SignedURL(context.Background(), key, "")
				}},
				{name: "thumbnail", process: mediaPreviewProcess, sign: func() (string, time.Time, error) {
					return store.SignedURL(context.Background(), key, mediaPreviewProcess)
				}},
				{name: "video-poster", process: mediaVideoPreviewProcess, sign: func() (string, time.Time, error) {
					return store.SignedURL(context.Background(), key, mediaVideoPreviewProcess)
				}},
				{name: "version", version: version, sign: func() (string, time.Time, error) {
					return target.SignedURLVersion(context.Background(), key, version, ttl)
				}},
				{name: "versioned-poster", version: version, process: mediaVideoPreviewProcess, sign: func() (string, time.Time, error) {
					return target.SignedMediaURL(context.Background(), key, version, mediaVideoPreviewProcess, "")
				}},
				{name: "versioned-download", version: version, disposition: disposition, sign: func() (string, time.Time, error) {
					return target.SignedMediaURL(context.Background(), key, version, "", disposition)
				}},
				{name: "download", disposition: disposition, sign: func() (string, time.Time, error) {
					return target.SignedDownloadURL(context.Background(), key, disposition)
				}},
				{name: "upload", sign: func() (string, time.Time, error) {
					return store.PresignPut(context.Background(), key, "image/png")
				}},
			}
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					before := time.Now()
					address, expires, err := tc.sign()
					if err != nil {
						t.Fatal(err)
					}
					parsed, err := url.Parse(address)
					if err != nil {
						t.Fatal(err)
					}
					if parsed.Scheme != "https" || parsed.Host != bucket+".oss-cn-hongkong.aliyuncs.com" || parsed.Path != "/"+key {
						t.Fatalf("wrong object address: scheme=%q host=%q path=%q", parsed.Scheme, parsed.Host, parsed.Path)
					}
					query := parsed.Query()
					if query.Get("versionId") != tc.version || query.Get("x-oss-process") != tc.process || query.Get("response-content-disposition") != tc.disposition {
						t.Fatal("version, processing or download parameters were changed")
					}
					if query.Get("x-oss-expires") != "900" || query.Get("x-oss-signature") == "" || !strings.Contains(query.Get("x-oss-credential"), "/cn-hongkong/oss/") {
						t.Fatal("regional signature or configured TTL was lost")
					}
					if expires.Before(before.Add(ttl-time.Second)) || expires.After(time.Now().Add(ttl+time.Second)) {
						t.Fatal("returned expiration does not match the signed TTL")
					}
				})
			}
		})
	}
}
