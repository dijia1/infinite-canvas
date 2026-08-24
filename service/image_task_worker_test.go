package service

import "testing"

func TestImageTaskWorkerConcurrencyDefaultsAndRejectsInvalidValues(t *testing.T) {
	if value, err := parseImageTaskWorkerConcurrency(0); err != nil || value != 4 {
		t.Fatalf("parseImageTaskWorkerConcurrency(0) = %d, %v", value, err)
	}
	if value, err := parseImageTaskWorkerConcurrency(7); err != nil || value != 7 {
		t.Fatalf("parseImageTaskWorkerConcurrency(7) = %d, %v", value, err)
	}
	if _, err := parseImageTaskWorkerConcurrency(-1); err == nil {
		t.Fatal("negative worker concurrency must be rejected")
	}
}
