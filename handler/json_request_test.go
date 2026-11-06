package handler

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJSONBodyBoundsTheEntireBodyAndKeepsOptionalEmptyInputs(t *testing.T) {
	cases := []struct {
		name, body           string
		strict               bool
		wantLarge, wantError bool
	}{
		{"valid", `{"title":"ok"}`, false, false, false},
		{"unknown compatible", `{"extra":true}`, false, false, false},
		{"strict", `{"extra":true}`, true, false, true},
		{"multiple", `{} {}`, false, false, true},
		{"oversized", `{"title":"` + strings.Repeat("x", 100) + `"}`, false, true, true},
		{"trailing oversized", `{}` + strings.Repeat(" ", 100), false, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var input struct {
				Title string `json:"title"`
			}
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			request.ContentLength = -1 // Limits must also work for chunked requests.
			recorder := httptest.NewRecorder()
			err := decodeJSONBody(recorder, request, &input, 64, tc.strict)
			if (err != nil) != tc.wantError || isRequestBodyTooLarge(err) != tc.wantLarge {
				t.Fatalf("error=%v", err)
			}
			if err != nil {
				writeJSONRequestError(recorder, err, "invalid")
				wantStatus := http.StatusBadRequest
				if tc.wantLarge {
					wantStatus = http.StatusRequestEntityTooLarge
				}
				if recorder.Code != wantStatus {
					t.Fatalf("status=%d", recorder.Code)
				}
			}
		})
	}
	var input struct{}
	err := decodeJSONBody(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", nil), &input, 64, false)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("empty body error=%v", err)
	}
}
