package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"
)

func TestImageRequestOptionsFromJSONRejectsNonObject(t *testing.T) {
	options, err := imageRequestOptionsFromJSON(json.RawMessage(`{"resolution":"1.5k","watermark":false}`))
	if err != nil {
		t.Fatalf("imageRequestOptionsFromJSON() error = %v", err)
	}
	if string(options["resolution"]) != `"1.5k"` || string(options["watermark"]) != "false" {
		t.Fatalf("imageRequestOptionsFromJSON() = %#v", options)
	}
	if _, err := imageRequestOptionsFromJSON(json.RawMessage(`[]`)); err == nil {
		t.Fatal("imageRequestOptionsFromJSON() accepted a non-object")
	}
}

func TestImageMaskFromFormRejectsMoreThanOneMask(t *testing.T) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for _, name := range []string{"mask-a.png", "mask-b.png"} {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="mask"; filename="`+name+`"`)
		header.Set("Content-Type", "image/png")
		part, err := writer.CreatePart(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte("\x89PNG\r\n\x1a\n")); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/api/v1/images/edits", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if err := request.ParseMultipartForm(50 << 20); err != nil {
		t.Fatal(err)
	}
	if _, err := imageMaskFromForm(request); err == nil {
		t.Fatal("imageMaskFromForm() accepted multiple masks")
	}
}

func TestReadMultipartImageReferencesRejectsReferencesOverTheSharedLimit(t *testing.T) {
	request := multipartRequestWithFiles(t, "input_reference[]", [][]byte{[]byte("ab"), []byte("cd")})
	if err := request.ParseMultipartForm(1 << 20); err != nil {
		t.Fatal(err)
	}
	if _, err := readMultipartImageReferences(request.MultipartForm.File["input_reference[]"], 3); err == nil {
		t.Fatal("readMultipartImageReferences() accepted references over the shared limit")
	}
}

func TestLimitMultipartRequestBodyRejectsPayloadBeforeParsing(t *testing.T) {
	request := multipartRequestWithFiles(t, "input_reference[]", [][]byte{[]byte("image")})
	limitMultipartRequestBody(httptest.NewRecorder(), request, 1)
	if err := request.ParseMultipartForm(1 << 20); err == nil {
		t.Fatal("ParseMultipartForm() accepted a body beyond its request limit")
	}
}

func multipartRequestWithFiles(t *testing.T, field string, files [][]byte) *http.Request {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for index, data := range files {
		part, err := writer.CreateFormFile(field, "reference-"+string(rune('a'+index))+".png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/videos", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}
