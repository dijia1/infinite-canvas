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

	inputs, err := SaveImageTaskInputs(context.Background(), "task-1", []ai.ImageReference{{Name: "reference.png", ContentType: "image/png", Data: tinyPNG}})
	if err != nil {
		t.Fatalf("SaveImageTaskInputs() error = %v", err)
	}
	if len(inputs) != 1 || !strings.HasPrefix(inputs[0].ObjectKey, "images/tasks/task-1/inputs/") {
		t.Fatalf("SaveImageTaskInputs() = %#v", inputs)
	}
	references, err := ReadImageTaskInputs(context.Background(), inputs)
	if err != nil || len(references) != 1 || references[0].Name != "reference.png" || string(references[0].Data) != string(tinyPNG) {
		t.Fatalf("ReadImageTaskInputs() = %#v, %v", references, err)
	}
	if err := DeleteImageTaskInputs(context.Background(), inputs); err != nil {
		t.Fatalf("DeleteImageTaskInputs() error = %v", err)
	}
	if len(store.objects) != 0 {
		t.Fatalf("temporary objects remain: %#v", store.objects)
	}
}
