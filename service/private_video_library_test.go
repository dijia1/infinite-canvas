package service

import (
	"context"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestPrivateVideoLibrarySeparatesKindsAndReusesMediaManagement(t *testing.T) {
	ctx := context.Background()
	user := PortalUser{UID: newID("private-video-owner")}
	store, err := newImageStore()
	if err != nil {
		t.Fatal(err)
	}
	videos := make([]model.Media, 0, 2)
	for _, source := range []model.MediaSource{model.MediaSourceUpload, model.MediaSourceGenerated} {
		item := model.Media{ID: newID("private-video"), OwnerUID: user.UID, Source: source, ObjectKey: newID("private-video-object") + ".mp4", ContentType: "video/mp4", Duration: 6, Width: 720, Height: 1280, CreatedAt: now()}
		if err := store.Put(ctx, item.ObjectKey, []byte("video fixture"), item.ContentType); err != nil {
			t.Fatal(err)
		}
		if _, err := repository.SaveMedia(item); err != nil {
			t.Fatal(err)
		}
		videos = append(videos, item)
	}
	image := model.Media{ID: newID("private-image"), OwnerUID: user.UID, Source: model.MediaSourceGenerated, ObjectKey: newID("private-image-object") + ".png", ContentType: "image/png", Title: "AI 图片", CreatedAt: now()}
	if _, err := repository.SaveMedia(image); err != nil {
		t.Fatal(err)
	}
	images, err := ListPrivateImages(ctx, user, "")
	if err != nil || len(images.Items) != 1 || images.Items[0].ID != image.ID {
		t.Fatalf("default image catalog contains videos: %+v, %v", images, err)
	}
	library, err := ListPrivateImages(ctx, user, "video")
	if err != nil || len(library.Items) != 2 {
		t.Fatalf("video catalog: %+v, %v", library, err)
	}
	for _, item := range library.Items {
		if item.Title != "视频" || item.ExpiresAt != nil {
			t.Fatalf("video library metadata: %+v", item)
		}
	}

	folder, err := CreatePrivateFolder(ctx, user, "视频文件夹", "")
	if err != nil {
		t.Fatal(err)
	}
	title, destination := "重命名的 AI 视频", folder.ID
	updated, err := UpdatePrivateImage(ctx, user, videos[1].ID, &title, &destination)
	if err != nil || updated.Title != title || updated.FolderID != folder.ID || updated.Source != model.MediaSourceGenerated || updated.ExpiresAt != nil {
		t.Fatalf("rename and move generated video: %+v, %v", updated, err)
	}
	library, err = ListPrivateImages(ctx, user, "video")
	if err != nil || len(library.Items) != 2 {
		t.Fatalf("moving a video removed it from the catalog: %+v, %v", library, err)
	}
	if err := DeletePrivateFolder(ctx, user, folder.ID); err == nil || !strings.Contains(err.Error(), "包含素材") {
		t.Fatalf("folder containing a video was deleted: %v", err)
	}
	root := ""
	if _, err := UpdatePrivateImage(ctx, user, videos[1].ID, nil, &root); err != nil {
		t.Fatal(err)
	}
	if err := DeletePrivateFolder(ctx, user, folder.ID); err != nil {
		t.Fatal(err)
	}
	for _, item := range videos {
		if err := DeletePrivateMedia(ctx, user, item.ID); err != nil {
			t.Fatal(err)
		}
		if _, found, err := repository.GetMedia(item.ID); err != nil || found {
			t.Fatalf("deleted video still exists: found=%t error=%v", found, err)
		}
		if err := DeletePrivateMedia(ctx, user, item.ID); err != nil {
			t.Fatalf("repeated deletion: %v", err)
		}
	}
	if _, found, err := repository.GetMedia(image.ID); err != nil || !found {
		t.Fatalf("video operations changed the image: found=%t error=%v", found, err)
	}
}
