package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
)

type safeResponseError string

func (err safeResponseError) Error() string       { return string(err) }
func (err safeResponseError) SafeMessage() string { return string(err) }

func TestFailErrorPreservesWrappedBusinessMessageAndRedactsStorageErrors(t *testing.T) {
	var output bytes.Buffer
	previousOutput := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previousOutput) })
	for _, test := range []struct {
		err     error
		message string
	}{
		{fmt.Errorf("保存操作: %w", safeResponseError("图片不存在")), "图片不存在"},
		{fmt.Errorf("读取对象: %w", &oss.ServiceError{StatusCode: 403, Code: "AccessDenied", RequestID: "request-123", RequestTarget: "https://private.example/object?Signature=secret"}), "操作失败"},
	} {
		recorder := httptest.NewRecorder()
		FailError(recorder, test.err)
		var result response
		if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil || result.Code != 1 || result.Msg != test.message {
			t.Fatalf("response=%+v err=%v", result, err)
		}
	}
	if strings.Contains(output.String(), "secret") || strings.Contains(output.String(), "private.example") || !strings.Contains(output.String(), "oss:AccessDenied http:403 request:request-123") {
		t.Fatalf("unsafe or missing diagnostic: %s", output.String())
	}
}

func TestFailStatusCommitsJSONContentTypeWithErrorStatus(t *testing.T) {
	recorder := httptest.NewRecorder()

	FailStatus(recorder, http.StatusConflict, "版本冲突")

	response := recorder.Result()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusConflict)
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}
}
