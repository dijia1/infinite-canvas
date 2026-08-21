package ai

import "testing"

func TestRegistryListsProviderTypesAndRejectsDuplicates(t *testing.T) {
	registry := NewRegistry()
	image := ProviderType{ID: "image-test", Name: "测试生图", Capabilities: []Capability{CapabilityImageGenerate, CapabilityImageEdit}}
	if err := registry.Register(image); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if err := registry.Register(image); err == nil {
		t.Fatal("Register() duplicate error = nil")
	}

	types := registry.Types()
	if len(types) != 1 || types[0].ID != "image-test" || !types[0].Supports(CapabilityImageEdit) {
		t.Fatalf("Types() = %#v", types)
	}
}
