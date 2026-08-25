package handler

import (
	"bytes"
	"mime/multipart"
	"net/http/httptest"
	"net/textproto"
	"testing"
)

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
