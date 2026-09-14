package repository

import "errors"

// ErrGenerationRequestConflict means one owner reused a generation request ID
// for a different normalized payload.
var ErrGenerationRequestConflict = errors.New("generation request id reused with a different payload")

func generationRequestHashMatches(existing, incoming string) bool {
	return existing == "" || existing == incoming
}
