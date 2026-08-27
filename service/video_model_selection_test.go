package service

import "testing"

func TestVideoTaskIdentityPreservesTheSelectedProvider(t *testing.T) {
	encoded := encodeVideoTaskID("video-model", "upstream-task-1")
	providerID, taskID, ok := decodeVideoTaskID(encoded)
	if !ok || providerID != "video-model" || taskID != "upstream-task-1" {
		t.Fatalf("decodeVideoTaskID(%q) = %q, %q, %t", encoded, providerID, taskID, ok)
	}
	if _, _, ok := decodeVideoTaskID("old-upstream-task"); ok {
		t.Fatal("decodeVideoTaskID() treated a legacy upstream ID as an encoded identity")
	}
}
