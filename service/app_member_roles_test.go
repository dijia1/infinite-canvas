package service

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"gorm.io/gorm"
)

func TestRoleChangeUsesSynchronizedTargetAndPortalActor(t *testing.T) {
	const actorUID = "role-service-admin"
	const targetUID = "role-service-target"
	if err := repository.UpsertPortalMembers([]model.PortalMember{
		{UserUID: actorUID, DisplayName: "角色管理员", Enabled: true, Roles: []string{"Portal 管理员"}, SyncedAt: time.Now().UTC()},
		{UserUID: targetUID, DisplayName: "真实目标成员", Enabled: true, Roles: []string{"Portal 设计师"}, SyncedAt: time.Now().UTC()},
	}); err != nil {
		t.Fatal(err)
	}
	ctx := WithPortalUser(context.Background(), PortalUser{UID: actorUID, Username: "header-admin"})

	changed, err := SetPortalMemberAppRole(ctx, targetUID, model.AppRolePublicAssetsManager)
	if err != nil {
		t.Fatal(err)
	}
	if changed.UserUID != targetUID || changed.DisplayName != "真实目标成员" || changed.AppRole != model.AppRolePublicAssetsManager {
		t.Fatalf("changed member = %+v", changed)
	}
	if len(changed.Roles) != 1 || changed.Roles[0] != "Portal 设计师" {
		t.Fatalf("Portal roles changed with app role: %#v", changed.Roles)
	}
	if repeated, err := SetPortalMemberAppRole(ctx, targetUID, model.AppRolePublicAssetsManager); err != nil || repeated.AppRole != model.AppRolePublicAssetsManager {
		t.Fatalf("repeated assignment = %+v, err=%v", repeated, err)
	}

	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var assignment model.AppMemberRole
	if err := database.Where("user_uid = ?", targetUID).First(&assignment).Error; err != nil {
		t.Fatal(err)
	}
	if assignment.GrantedByUID != actorUID {
		t.Fatalf("grantedByUid = %q, want Portal-context actor %q", assignment.GrantedByUID, actorUID)
	}
}

func TestRoleChangeRejectsInvalidRoleAndUnavailableTarget(t *testing.T) {
	const actorUID = "role-service-validation-admin"
	const enabledUID = "role-service-validation-enabled"
	const disabledUID = "role-service-validation-disabled"
	if err := repository.UpsertPortalMembers([]model.PortalMember{
		{UserUID: actorUID, DisplayName: actorUID, Enabled: true, Roles: []string{}},
		{UserUID: enabledUID, DisplayName: enabledUID, Enabled: true, Roles: []string{}},
		{UserUID: disabledUID, DisplayName: disabledUID, Enabled: false, Roles: []string{}},
	}); err != nil {
		t.Fatal(err)
	}
	ctx := WithPortalUser(context.Background(), PortalUser{UID: actorUID})

	for _, test := range []struct {
		name string
		uid  string
		role model.AppRole
	}{
		{name: "invalid role", uid: enabledUID, role: model.AppRole("owner")},
		{name: "disabled target", uid: disabledUID, role: model.AppRoleAdmin},
		{name: "missing target", uid: "role-service-validation-missing", role: model.AppRoleAdmin},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := SetPortalMemberAppRole(ctx, test.uid, test.role); !IsAppMemberRoleValidationError(err) {
				t.Fatalf("SetPortalMemberAppRole() error = %v, want validation error", err)
			}
		})
	}
}

func TestRoleChangeMemberListUsesOneBatchedRoleQuery(t *testing.T) {
	prefix := fmt.Sprintf("role-list-%d", time.Now().UnixNano())
	members := []model.PortalMember{
		{UserUID: prefix + "-member", DisplayName: prefix + "-A", Enabled: true, Roles: []string{"Portal member"}},
		{UserUID: prefix + "-manager", DisplayName: prefix + "-B", Enabled: true, Roles: []string{"Portal manager"}},
	}
	if err := repository.UpsertPortalMembers(members); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetAppRole(members[1].UserUID, model.AppRolePublicAssetsManager, "role-list-admin", false); err != nil {
		t.Fatal(err)
	}
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var roleQueries atomic.Int64
	callbackName := "test:count-batched-app-role-query:" + prefix
	if err := database.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Schema != nil && tx.Statement.Schema.Table == "app_member_roles" {
			roleQueries.Add(1)
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Callback().Query().Remove(callbackName) })

	result, err := ListPortalMembers(model.PortalMemberQuery{Query: prefix, Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 2 || len(result.Items) != 2 {
		t.Fatalf("member list = %+v", result)
	}
	if roleQueries.Load() != 1 {
		t.Fatalf("app role query count = %d, want one batched query", roleQueries.Load())
	}
	roles := map[string]model.AppRole{}
	for _, item := range result.Items {
		roles[item.UserUID] = item.AppRole
	}
	if roles[members[0].UserUID] != model.AppRoleMember || roles[members[1].UserUID] != model.AppRolePublicAssetsManager {
		t.Fatalf("listed app roles = %#v", roles)
	}
}

func TestDirectorySyncPreservesAppRoleWhenPortalIdentityChanges(t *testing.T) {
	const targetUID = "6304df3b-b44d-4db9-a4bd-7b3a876953ba"
	if err := repository.UpsertPortalMembers([]model.PortalMember{{
		UserUID: targetUID, DisplayName: "同步前姓名", Enabled: true, Roles: []string{"旧 Portal 角色"}, SyncedAt: time.Now().UTC(),
	}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetAppRole(targetUID, model.AppRolePublicAssetsManager, "directory-sync-admin", false); err != nil {
		t.Fatal(err)
	}
	directory := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"users":[{"userUid":"` + targetUID + `","displayName":"同步后姓名","enabled":true,"roles":["新 Portal 角色"]}]}`))
	}))
	defer directory.Close()
	previous := config.Cfg
	config.Cfg.PortalDirectoryURL = directory.URL
	config.Cfg.PortalDirectoryAppKey = "infinite-canvas"
	config.Cfg.PortalDirectorySecret = "directory-secret"
	t.Cleanup(func() { config.Cfg = previous })

	if _, err := SyncPortalMembers(context.Background()); err != nil {
		t.Fatal(err)
	}
	member, found, err := repository.GetPortalMember(targetUID)
	if err != nil || !found || member.DisplayName != "同步后姓名" || len(member.Roles) != 1 || member.Roles[0] != "新 Portal 角色" {
		t.Fatalf("synchronized member = %+v, found=%t, err=%v", member, found, err)
	}
	role, err := repository.ResolveAppRole(targetUID)
	if err != nil || role != model.AppRolePublicAssetsManager {
		t.Fatalf("app role after directory sync = %q, err=%v", role, err)
	}
}

func TestDirectorySyncDisablesLastEnabledAdminAndPreservesRole(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Where("role = ?", model.AppRoleAdmin).Delete(&model.AppMemberRole{}).Error; err != nil {
		t.Fatal(err)
	}
	const demotedUID = "772802d2-4501-493f-821c-b3bd49e9c220"
	const lastAdminUID = "91813cd8-17df-4b31-9795-7b9bff49e32a"
	if err := repository.UpsertPortalMembers([]model.PortalMember{
		{UserUID: demotedUID, DisplayName: "已降级成员", Enabled: true, Roles: []string{}},
		{UserUID: lastAdminUID, DisplayName: "最后管理员", Enabled: true, Roles: []string{"Portal metadata"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetAppRole(demotedUID, model.AppRoleAdmin, lastAdminUID, false); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetAppRole(lastAdminUID, model.AppRoleAdmin, demotedUID, false); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetAppRole(demotedUID, model.AppRoleMember, lastAdminUID, false); err != nil {
		t.Fatal(err)
	}
	directory := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"users":[{"userUid":"` + demotedUID + `","displayName":"已降级成员的新姓名","enabled":true,"roles":[]}]}`))
	}))
	defer directory.Close()
	previous := config.Cfg
	config.Cfg.PortalDirectoryURL = directory.URL
	config.Cfg.PortalDirectoryAppKey = "infinite-canvas"
	config.Cfg.PortalDirectorySecret = "directory-secret"
	t.Cleanup(func() { config.Cfg = previous })

	if _, err := SyncPortalMembers(context.Background()); err != nil {
		t.Fatal(err)
	}
	lastAdmin, found, err := repository.GetPortalMember(lastAdminUID)
	if err != nil || !found || lastAdmin.Enabled {
		t.Fatalf("disabled member = %+v found=%t err=%v", lastAdmin, found, err)
	}
	role, err := repository.ResolveAppRole(lastAdminUID)
	if err != nil || role != model.AppRoleAdmin {
		t.Fatalf("preserved role=%q err=%v", role, err)
	}
	demoted, found, err := repository.GetPortalMember(demotedUID)
	if err != nil || !found || demoted.DisplayName != "已降级成员的新姓名" {
		t.Fatalf("updated member=%+v found=%t err=%v", demoted, found, err)
	}
}
