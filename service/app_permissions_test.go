package service

import (
	"context"
	"os"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/internal/testpostgres"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestMain(m *testing.M) {
	directory, err := os.MkdirTemp("", "infinite-canvas-service-test-")
	if err != nil {
		panic(err)
	}
	schema, err := testpostgres.NewSchema("service")
	if err != nil {
		panic(err)
	}
	config.Cfg = config.Config{
		DatabaseDSN:  schema.DSN,
		MediaStorage: "local", MediaLocalDir: directory,
	}
	if _, err := repository.DB(); err != nil {
		panic(err)
	}
	code := m.Run()
	closeRepositoryPool()
	_ = schema.Close()
	_ = os.RemoveAll(directory)
	os.Exit(code)
}

func closeRepositoryPool() {
	database, _ := repository.DB()
	if database == nil {
		return
	}
	sqlDB, err := database.DB()
	if err == nil {
		_ = sqlDB.Close()
	}
}

func seedPermissionMember(t *testing.T, userUID string, enabled bool) {
	t.Helper()
	if err := repository.UpsertPortalMembers([]model.PortalMember{{
		UserUID: userUID, DisplayName: userUID, Enabled: enabled, Roles: []string{},
	}}); err != nil {
		t.Fatal(err)
	}
}

func TestVerifiedGatewayAdminRoleGrantsGlobalPermissions(t *testing.T) {
	const userUID = "gateway-admin-permission-member"
	seedPermissionMember(t, userUID, true)

	permissions, err := ResolveAppPermissions(context.Background(), PortalUser{
		UID: userUID, Roles: []string{"portal-admin"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if permissions.AppRole != model.AppRoleAdmin || !permissions.IsAdmin || !permissions.CanManagePublicAssets {
		t.Fatalf("permissions = %+v, want global admin capabilities", permissions)
	}
}

func TestLocalPublicAssetsManagerPermissionMatrix(t *testing.T) {
	tests := []struct {
		name                   string
		userUID                string
		role                   model.AppRole
		seedMember             bool
		enabled                bool
		wantRole               model.AppRole
		wantAdmin              bool
		wantPublicAssetManager bool
	}{
		{name: "enabled admin", userUID: "permission-enabled-admin", role: model.AppRoleAdmin, seedMember: true, enabled: true, wantRole: model.AppRoleAdmin, wantAdmin: true, wantPublicAssetManager: true},
		{name: "enabled public assets manager", userUID: "permission-enabled-manager", role: model.AppRolePublicAssetsManager, seedMember: true, enabled: true, wantRole: model.AppRolePublicAssetsManager, wantPublicAssetManager: true},
		{name: "enabled member without assignment", userUID: "permission-enabled-member", role: model.AppRoleMember, seedMember: true, enabled: true, wantRole: model.AppRoleMember},
		{name: "disabled admin", userUID: "permission-disabled-admin", role: model.AppRoleAdmin, seedMember: true, enabled: false, wantRole: model.AppRoleMember},
		{name: "missing synchronized member", userUID: "permission-missing-member", role: model.AppRoleAdmin, wantRole: model.AppRoleMember},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.seedMember {
				seedPermissionMember(t, test.userUID, test.enabled)
			}
			if test.role != model.AppRoleMember {
				if err := repository.SetAppRole(test.userUID, test.role, "test-grantor", false); err != nil {
					t.Fatal(err)
				}
			}

			permissions, err := ResolveAppPermissions(context.Background(), PortalUser{
				UID: test.userUID, Roles: []string{"member", "portal-public-assets-manager"},
			})
			if err != nil {
				t.Fatal(err)
			}
			if permissions.AppRole != test.wantRole || permissions.IsAdmin != test.wantAdmin || permissions.CanManagePublicAssets != test.wantPublicAssetManager {
				t.Fatalf("permissions = %+v, want role=%q admin=%t publicAssets=%t", permissions, test.wantRole, test.wantAdmin, test.wantPublicAssetManager)
			}
		})
	}
}

func TestResolveAppPermissionsReturnsStorageErrorsOnlyForEnabledMembers(t *testing.T) {
	const enabledUID = "permission-storage-error-enabled"
	const disabledUID = "permission-storage-error-disabled"
	seedPermissionMember(t, enabledUID, true)
	seedPermissionMember(t, disabledUID, false)

	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrator().DropTable(&model.AppMemberRole{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.AutoMigrate(&model.AppMemberRole{}); err != nil {
			t.Errorf("restore app role table: %v", err)
		}
	})

	if permissions, err := ResolveAppPermissions(context.Background(), PortalUser{UID: disabledUID}); err != nil || permissions.AppRole != model.AppRoleMember {
		t.Fatalf("disabled permissions = %+v, err=%v; want local member without storage error", permissions, err)
	}
	if permissions, err := ResolveAppPermissions(context.Background(), PortalUser{UID: "permission-storage-error-missing"}); err != nil || permissions.AppRole != model.AppRoleMember {
		t.Fatalf("missing permissions = %+v, err=%v; want local member without storage error", permissions, err)
	}
	if _, err := ResolveAppPermissions(context.Background(), PortalUser{UID: enabledUID}); err == nil {
		t.Fatal("enabled member permission lookup hid the application-role storage error")
	}
}
