package service

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
)

var tinyPNG = []byte("\x89PNG\r\n\x1a\n")

type memoryTaskInputStore struct {
	objects map[string][]byte
}

func (store *memoryTaskInputStore) Put(_ context.Context, key string, data []byte, _ string) error {
	if store.objects == nil {
		store.objects = map[string][]byte{}
	}
	store.objects[key] = append([]byte{}, data...)
	return nil
}
func (store *memoryTaskInputStore) Delete(_ context.Context, key string) error {
	delete(store.objects, key)
	return nil
}
func (store *memoryTaskInputStore) SignedURL(context.Context, string, string) (string, time.Time, error) {
	return "", time.Time{}, nil
}
func (store *memoryTaskInputStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader(string(store.objects[key]))), nil
}

func TestImageTaskInputsRoundTripAndDelete(t *testing.T) {
	store := &memoryTaskInputStore{}
	previousFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousFactory })

	inputs, err := SaveImageTaskInputs(context.Background(), "task-1", []ai.ImageReference{{Name: "reference.png", ContentType: "image/png", Data: tinyPNG}}, nil)
	if err != nil {
		t.Fatalf("SaveImageTaskInputs() error = %v", err)
	}
	if len(inputs) != 1 || !strings.HasPrefix(inputs[0].ObjectKey, "images/tasks/task-1/inputs/") {
		t.Fatalf("SaveImageTaskInputs() = %#v", inputs)
	}
	loaded, err := ReadImageTaskInputs(context.Background(), inputs)
	if err != nil || len(loaded.References) != 1 || loaded.References[0].Name != "reference.png" || string(loaded.References[0].Data) != string(tinyPNG) || loaded.Mask != nil {
		t.Fatalf("ReadImageTaskInputs() = %#v, %v", loaded, err)
	}
	if err := DeleteImageTaskInputs(context.Background(), inputs); err != nil {
		t.Fatalf("DeleteImageTaskInputs() error = %v", err)
	}
	if len(store.objects) != 0 {
		t.Fatalf("temporary objects remain: %#v", store.objects)
	}
}

func TestImageTaskInputsRoundTripPNGMaskAndRejectsOtherMaskTypes(t *testing.T) {
	store := &memoryTaskInputStore{}
	previousFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousFactory })

	inputs, err := SaveImageTaskInputs(
		context.Background(),
		"task-masked",
		[]ai.ImageReference{{Name: "reference.png", ContentType: "image/png", Data: tinyPNG}},
		&ai.ImageReference{Name: "mask.png", ContentType: "image/png", Data: tinyPNG},
	)
	if err != nil {
		t.Fatalf("SaveImageTaskInputs() error = %v", err)
	}
	if len(inputs) != 2 || inputs[0].Purpose != "image" || inputs[1].Purpose != "mask" {
		t.Fatalf("saved inputs = %#v", inputs)
	}
	loaded, err := ReadImageTaskInputs(context.Background(), inputs)
	if err != nil || len(loaded.References) != 1 || loaded.Mask == nil || loaded.Mask.Name != "mask.png" || string(loaded.Mask.Data) != string(tinyPNG) {
		t.Fatalf("ReadImageTaskInputs() = %#v, %v", loaded, err)
	}
	if err := DeleteImageTaskInputs(context.Background(), inputs); err != nil || len(store.objects) != 0 {
		t.Fatalf("DeleteImageTaskInputs() error = %v, objects = %#v", err, store.objects)
	}

	if _, err := SaveImageTaskInputs(context.Background(), "task-jpeg-mask", []ai.ImageReference{{Name: "reference.png", ContentType: "image/png", Data: tinyPNG}}, &ai.ImageReference{Name: "mask.jpg", ContentType: "image/jpeg", Data: tinyPNG}); err == nil {
		t.Fatal("SaveImageTaskInputs() accepted a non-PNG mask")
	}
}
