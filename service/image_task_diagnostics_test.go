package service

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/basketikun/infinite-canvas/model"
)

type versioningDiagnosticStore struct {
	versionedImageStore
	err error
}

func (store versioningDiagnosticStore) EnsureVersioningEnabled(context.Context) error {
	return store.err
}

func TestImagePreparationLogsOSSCategoryWithoutSignedTarget(t *testing.T) {
	previousFactory, previousWriter := taskInputStoreFactory, log.Writer()
	t.Cleanup(func() { taskInputStoreFactory = previousFactory; log.SetOutput(previousWriter) })
	taskInputStoreFactory = func() (imageStore, error) {
		return versioningDiagnosticStore{err: &oss.ServiceError{StatusCode: 403, Code: "AccessDenied", RequestID: "diagnostic-request", RequestTarget: "https://secret.example/?Signature=secret"}}, nil
	}
	var output bytes.Buffer
	log.SetOutput(&output)
	deadline := time.Now().UTC().Add(time.Hour)
	prepareImageGenerationTask(context.Background(), model.ImageGenerationTask{ID: "diagnostic-task", Deadline: &deadline})
	if !strings.Contains(output.String(), "oss:AccessDenied") || !strings.Contains(output.String(), "diagnostic-request") || strings.Contains(output.String(), "secret") || strings.Contains(output.String(), "Signature") {
		t.Fatalf("diagnostics=%q", output.String())
	}
}
