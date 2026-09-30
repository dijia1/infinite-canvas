package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestReadImageTaskMediaReferencesKeepsRequestedOrderAndChecksAccess(t *testing.T) {
	store := &memoryTaskInputStore{objects: map[string][]byte{"images/a.png": tinyPNG, "images/b.png": tinyPNG, "images/public.png": tinyPNG}}
	items := map[string]model.Media{
		"media-a":      {ID: "media-a", OwnerUID: "owner", ObjectKey: "images/a.png", Filename: "a.png", ContentType: "image/png"},
		"media-b":      {ID: "media-b", OwnerUID: "owner", ObjectKey: "images/b.png", Filename: "b.png", ContentType: "image/png"},
		"media-public": {ID: "media-public", OwnerUID: "uploader", ObjectKey: "images/public.png", Filename: "public.png", ContentType: "image/png"},
	}
	getMedia := func(id string) (model.Media, bool, error) { item, found := items[id]; return item, found, nil }
	getPublic := func(id string) (model.PublicImage, bool, error) {
		return model.PublicImage{MediaID: id}, id == "media-public", nil
	}

	references, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "owner"}, []string{"media-b", "media-a"}, getMedia, getPublic, store)
	if err != nil {
		t.Fatalf("readImageTaskMediaReferences() error = %v", err)
	}
	if len(references) != 2 || references[0].Name != "b.png" || references[1].Name != "a.png" {
		t.Fatalf("references = %#v, want ordered media references", references)
	}

	if _, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "other"}, []string{"media-a"}, getMedia, getPublic, store); err == nil {
		t.Fatal("readImageTaskMediaReferences() accepted another user's private image")
	}
	if _, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "other"}, []string{"media-public"}, getMedia, getPublic, store); err != nil {
		t.Fatalf("readImageTaskMediaReferences() rejected a public image: %v", err)
	}
	missing := func(string) (model.Media, bool, error) { return model.Media{}, false, nil }
	if _, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "owner"}, []string{"missing"}, missing, getPublic, store); err == nil {
		t.Fatal("readImageTaskMediaReferences() accepted a missing image")
	}
	failing := func(string) (model.Media, bool, error) {
		return model.Media{}, false, errors.New("database unavailable")
	}
	if _, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "owner"}, []string{"media-a"}, failing, getPublic, store); err == nil {
		t.Fatal("readImageTaskMediaReferences() hid repository errors")
	}
}

func TestLocalAdminMediaReferencesAllowCrossUserPrivateImages(t *testing.T) {
	const adminUID = "local-admin-image-reference"
	seedPermissionMember(t, adminUID, true)
	if err := repository.SetAppRole(adminUID, model.AppRoleAdmin, "test-grantor", false); err != nil {
		t.Fatal(err)
	}
	store := &memoryTaskInputStore{objects: map[string][]byte{"images/private-owner.png": tinyPNG}}
	item := model.Media{ID: "local-admin-reference-media", OwnerUID: "private-owner", ObjectKey: "images/private-owner.png", Filename: "private-owner.png", ContentType: "image/png"}
	getMedia := func(id string) (model.Media, bool, error) { return item, id == item.ID, nil }
	getPublic := func(string) (model.PublicImage, bool, error) { return model.PublicImage{}, false, nil }

	references, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: adminUID, Roles: []string{"member"}}, []string{item.ID}, getMedia, getPublic, store)
	if err != nil {
		t.Fatalf("local admin reference access error = %v", err)
	}
	if len(references) != 1 || references[0].Name != item.Filename {
		t.Fatalf("references = %#v, want one cross-user private reference", references)
	}
}

type failingReferenceStore struct {
	imageStore
	err error
}

func (store failingReferenceStore) Get(context.Context, string) (io.ReadCloser, error) {
	return nil, store.err
}

func TestReferenceMissingObjectFailsClearlyWithoutLeakingStorageURL(t *testing.T) {
	cases := []struct {
		name    string
		err     error
		message string
	}{
		{"oss missing", fmt.Errorf("wrapped: %w", &oss.ServiceError{StatusCode: 404, Code: "NoSuchKey", RequestTarget: "https://secret/?Signature=secret"}), "参考图片文件不存在"},
		{"local missing", fmt.Errorf("wrapped: %w", os.ErrNotExist), "参考图片文件不存在"},
		{"access denied", &oss.ServiceError{StatusCode: 403, Code: "AccessDenied"}, "存储访问被拒绝"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			item := model.Media{ID: "missing-ref", OwnerUID: "owner", ObjectKey: "missing.png"}
			_, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "owner"}, []string{item.ID}, func(string) (model.Media, bool, error) { return item, true, nil }, func(string) (model.PublicImage, bool, error) { return model.PublicImage{}, false, nil }, failingReferenceStore{err: tc.err})
			var safe interface{ SafeMessage() string }
			if !errors.As(err, &safe) || !strings.Contains(safe.SafeMessage(), tc.message) || strings.Contains(err.Error(), "Signature") {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestReferenceTransientStorageFailureRemainsRetryable(t *testing.T) {
	failure := &oss.ServiceError{StatusCode: 503, Code: "ServiceUnavailable", RequestTarget: "https://secret/?Signature=secret"}
	item := model.Media{ID: "temporary-ref", OwnerUID: "owner", ObjectKey: "image.png"}
	_, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "owner"}, []string{item.ID}, func(string) (model.Media, bool, error) { return item, true, nil }, func(string) (model.PublicImage, bool, error) { return model.PublicImage{}, false, nil }, failingReferenceStore{err: failure})
	if !errors.Is(err, failure) {
		t.Fatalf("error=%v", err)
	}
	if strings.Contains(taskErrorCategory(err), "secret") {
		t.Fatal("diagnostics leaked signed URL")
	}
}
