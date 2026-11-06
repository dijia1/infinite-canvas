package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const maxMetadataRequestBytes = 64 << 10
const maxSettingsRequestBytes = 1 << 20
const maxGenerationRequestBytes = 1 << 20

// Check the trailing bytes too: a valid first object must not bypass the limit.
func decodeJSONBody(w http.ResponseWriter, r *http.Request, destination any, maxBytes int64, strict bool) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return errors.New("request contains multiple JSON values")
	}
	return nil
}

func isRequestBodyTooLarge(err error) bool {
	var tooLarge *http.MaxBytesError
	return errors.As(err, &tooLarge)
}

func writeJSONRequestError(w http.ResponseWriter, err error, message string) {
	if isRequestBodyTooLarge(err) {
		FailStatus(w, http.StatusRequestEntityTooLarge, "请求数据超过上限")
		return
	}
	FailStatus(w, http.StatusBadRequest, message)
}
