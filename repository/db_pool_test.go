package repository

import "testing"

func TestDatabaseUsesConservativeConnectionPoolDefaults(t *testing.T) {
	useImageTaskTestDB(t)
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	stats := sqlDB.Stats()
	if stats.MaxOpenConnections != 20 {
		t.Fatalf("max open connections = %d, want 20", stats.MaxOpenConnections)
	}
}
