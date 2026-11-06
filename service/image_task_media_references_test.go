package service

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestResolveImageTaskMediaSourcesKeepsOrderAndChecksAccess(t *testing.T) {
	owner := newID("reference-owner")
	items := []model.Media{
		{ID: newID("ref-a"), OwnerUID: owner, ObjectKey: "a.png", Filename: "a.png", ContentType: "image/png"},
		{ID: newID("ref-b"), OwnerUID: owner, ObjectKey: "b.png", Filename: "b.png", ContentType: "image/png"},
	}
	for _, item := range items {
		if _, err := repository.SaveMedia(item); err != nil {
			t.Fatal(err)
		}
	}
	public := items[0]
	if _, err := repository.SavePublicImage(model.PublicImage{ID: newID("public-ref"), MediaID: public.ID, Title: "public", UploaderUID: owner, CreatedAt: now()}); err != nil {
		t.Fatal(err)
	}
	sources, err := resolveImageTaskMediaSources(context.Background(), PortalUser{UID: owner}, []string{items[1].ID, items[0].ID})
	if err != nil || len(sources) != 2 || sources[0].ID != items[1].ID || sources[1].ID != items[0].ID {
		t.Fatalf("ordered sources=%+v err=%v", sources, err)
	}
	other := PortalUser{UID: newID("other")}
	if _, err := resolveImageTaskMediaSources(context.Background(), other, []string{items[1].ID}); err == nil {
		t.Fatal("foreign private image accepted")
	}
	if _, err := resolveImageTaskMediaSources(context.Background(), other, []string{public.ID}); err != nil {
		t.Fatalf("public image rejected: %v", err)
	}
	for _, ids := range [][]string{{newID("missing")}, {""}, nil} {
		if _, err := resolveImageTaskMediaSources(context.Background(), PortalUser{UID: owner}, ids); err == nil {
			t.Fatalf("invalid sources accepted: %v", ids)
		}
	}
	adminUID := newID("admin-reference")
	seedPermissionMember(t, adminUID, true)
	if err := repository.SetAppRole(adminUID, model.AppRoleAdmin, "test-grantor", false); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveImageTaskMediaSources(context.Background(), PortalUser{UID: adminUID, Roles: []string{"member"}}, []string{items[1].ID}); err != nil {
		t.Fatalf("admin private reference rejected: %v", err)
	}
}

func TestImageTaskFailureDiagnosticsDoNotExposeSignedStorageErrors(t *testing.T) {
	for _, status := range []int{403, 404, 503} {
		err := fmt.Errorf("wrapped: %w", &oss.ServiceError{StatusCode: status, Code: "StorageError", RequestTarget: "https://secret.example/?Signature=secret"})
		if message := imageTaskFailureMessage(err); message == "" || strings.Contains(message, "secret") || strings.Contains(message, "Signature") {
			t.Fatalf("unsafe task message: %s", message)
		}
		if strings.Contains(TaskErrorCategory(err), "secret") {
			t.Fatal("unsafe diagnostic category")
		}
	}
}
