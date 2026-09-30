package repository

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const (
	initialAdminUID    = "11111111-1111-4111-8111-111111111111"
	secondAdminUID     = "22222222-2222-4222-8222-222222222222"
	disabledAdminUID   = "33333333-3333-4333-8333-333333333333"
	normalizedAdminUID = "aabbccdd-eeff-4abc-8def-aabbccddeeff"
)

func useAppRoleTestDB(t *testing.T) {
	t.Helper()
	cfg := newRepositoryTestConfig(t, "app_member_role")
	cfg.DatabaseMaxOpenConns = 5
	cfg.DatabaseMaxIdleConns = 5
	useRepositoryTestDB(t, cfg)
}

func savePortalMemberForAppRole(t *testing.T, userUID string, enabled bool) {
	t.Helper()
	if err := UpsertPortalMembers([]model.PortalMember{{
		UserUID: userUID, DisplayName: userUID, Enabled: enabled, Roles: []string{},
	}}); err != nil {
		t.Fatal(err)
	}
}

func TestAppRBACStateMigrationUsesSingularTable(t *testing.T) {
	useAppRoleTestDB(t)
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if !database.Migrator().HasTable("app_rbac_state") {
		t.Fatal("AutoMigrate did not create app_rbac_state")
	}
	if database.Migrator().HasTable("app_rbac_states") {
		t.Fatal("AutoMigrate created the plural app_rbac_states table")
	}
}

func TestResolveAppRoleDefaultsToMember(t *testing.T) {
	useAppRoleTestDB(t)

	role, err := ResolveAppRole("member-uid")
	if err != nil || role != model.AppRoleMember {
		t.Fatalf("role=%q err=%v", role, err)
	}
}

func TestResolveAppRoleStoresOnlyExplicitAssignments(t *testing.T) {
	useAppRoleTestDB(t)

	if err := SetAppRole("member-uid", model.AppRolePublicAssetsManager, "grantor-uid", false); err != nil {
		t.Fatal(err)
	}
	role, err := ResolveAppRole("member-uid")
	if err != nil || role != model.AppRolePublicAssetsManager {
		t.Fatalf("explicit role=%q err=%v", role, err)
	}
	if err := SetAppRole("member-uid", model.AppRoleMember, "grantor-uid", false); err != nil {
		t.Fatal(err)
	}

	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := database.Model(&model.AppMemberRole{}).Where("user_uid = ?", "member-uid").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("implicit member assignment left %d stored rows", count)
	}
}

func TestBootstrapAppAdminsRunsOnlyOnce(t *testing.T) {
	useAppRoleTestDB(t)
	savePortalMemberForAppRole(t, initialAdminUID, true)
	savePortalMemberForAppRole(t, secondAdminUID, true)

	if err := BootstrapAppAdmins([]string{initialAdminUID, secondAdminUID}); err != nil {
		t.Fatal(err)
	}
	if err := SetAppRole(initialAdminUID, model.AppRoleMember, secondAdminUID, false); err != nil {
		t.Fatal(err)
	}
	if err := BootstrapAppAdmins([]string{initialAdminUID}); err != nil {
		t.Fatal(err)
	}
	role, err := ResolveAppRole(initialAdminUID)
	if err != nil {
		t.Fatal(err)
	}
	if role != model.AppRoleMember {
		t.Fatalf("bootstrap reassigned %q", role)
	}
}

func TestBootstrapAppAdminsFromDirectorySkipsSnapshotAfterCompletion(t *testing.T) {
	useAppRoleTestDB(t)
	savePortalMemberForAppRole(t, initialAdminUID, true)
	if err := BootstrapAppAdmins([]string{initialAdminUID}); err != nil {
		t.Fatal(err)
	}

	if err := BootstrapAppAdminsFromDirectory([]model.PortalMember{{
		UserUID: initialAdminUID, DisplayName: "过期目录快照", Enabled: false, Roles: []string{"过期展示角色"},
	}}, []string{initialAdminUID}); err != nil {
		t.Fatal(err)
	}
	member, found, err := GetPortalMember(initialAdminUID)
	if err != nil || !found || !member.Enabled || member.DisplayName != initialAdminUID {
		t.Fatalf("member after stale snapshot = %+v, found=%t, err=%v", member, found, err)
	}
}

func TestBootstrapAppAdminsFromDirectoryRollsBackInvalidSnapshotAndRetries(t *testing.T) {
	useAppRoleTestDB(t)
	savePortalMemberForAppRole(t, initialAdminUID, true)
	savePortalMemberForAppRole(t, secondAdminUID, true)
	if err := SetAppRole(secondAdminUID, model.AppRolePublicAssetsManager, initialAdminUID, false); err != nil {
		t.Fatal(err)
	}

	invalidSnapshot := []model.PortalMember{
		{UserUID: initialAdminUID, DisplayName: "被回滚的名称", Enabled: true, Roles: []string{"被回滚的展示角色"}},
		{UserUID: normalizedAdminUID, DisplayName: "仅快照成员", Enabled: true, Roles: []string{}},
	}
	if err := BootstrapAppAdminsFromDirectory(invalidSnapshot, []string{secondAdminUID}); err == nil {
		t.Fatal("bootstrap accepted an initial administrator disabled by the snapshot")
	}

	for _, expected := range []model.PortalMember{
		{UserUID: initialAdminUID, DisplayName: initialAdminUID, Enabled: true, Roles: []string{}},
		{UserUID: secondAdminUID, DisplayName: secondAdminUID, Enabled: true, Roles: []string{}},
	} {
		member, found, err := GetPortalMember(expected.UserUID)
		if err != nil || !found || member.DisplayName != expected.DisplayName || member.Enabled != expected.Enabled || len(member.Roles) != 0 {
			t.Fatalf("member %q after failed bootstrap = %+v, found=%t, err=%v", expected.UserUID, member, found, err)
		}
	}
	if _, found, err := GetPortalMember(normalizedAdminUID); err != nil || found {
		t.Fatalf("snapshot-only member found=%t, err=%v", found, err)
	}
	if role, err := ResolveAppRole(secondAdminUID); err != nil || role != model.AppRolePublicAssetsManager {
		t.Fatalf("existing role after failed bootstrap = %q, err=%v", role, err)
	}
	completed, err := AppRBACBootstrapCompleted()
	if err != nil || completed {
		t.Fatalf("bootstrap completed after failed snapshot = %t, err=%v", completed, err)
	}

	validSnapshot := append(invalidSnapshot, model.PortalMember{UserUID: secondAdminUID, DisplayName: "重试管理员", Enabled: true, Roles: []string{"重试展示角色"}})
	if err := BootstrapAppAdminsFromDirectory(validSnapshot, []string{secondAdminUID}); err != nil {
		t.Fatal(err)
	}
	completed, err = AppRBACBootstrapCompleted()
	if err != nil || !completed {
		t.Fatalf("bootstrap completed after corrected retry = %t, err=%v", completed, err)
	}
	if role, err := ResolveAppRole(secondAdminUID); err != nil || role != model.AppRoleAdmin {
		t.Fatalf("retry administrator role = %q, err=%v", role, err)
	}
	if member, found, err := GetPortalMember(normalizedAdminUID); err != nil || !found || member.DisplayName != "仅快照成员" || !member.Enabled {
		t.Fatalf("snapshot-only member after corrected retry = %+v, found=%t, err=%v", member, found, err)
	}
}

func TestBootstrapAppAdminsRequiresConfiguredUIDsOnFirstRun(t *testing.T) {
	useAppRoleTestDB(t)

	if err := BootstrapAppAdmins(nil); err == nil {
		t.Fatal("empty initial administrator list was accepted")
	}
	savePortalMemberForAppRole(t, initialAdminUID, true)
	if err := BootstrapAppAdmins([]string{initialAdminUID}); err != nil {
		t.Fatalf("failed bootstrap marked completion: %v", err)
	}
}

func TestBootstrapAppAdminsRejectsInvalidUID(t *testing.T) {
	useAppRoleTestDB(t)

	if err := BootstrapAppAdmins([]string{"not-a-uuid"}); err == nil {
		t.Fatal("invalid initial administrator UID was accepted")
	}
}

func TestBootstrapAppAdminsNormalizesAndDeduplicatesValidUUIDs(t *testing.T) {
	useAppRoleTestDB(t)
	savePortalMemberForAppRole(t, normalizedAdminUID, true)
	uppercase := strings.ToUpper(normalizedAdminUID)
	compact := strings.ReplaceAll(normalizedAdminUID, "-", "")

	if err := BootstrapAppAdmins([]string{uppercase, compact, normalizedAdminUID}); err != nil {
		t.Fatal(err)
	}
	role, err := ResolveAppRole(normalizedAdminUID)
	if err != nil || role != model.AppRoleAdmin {
		t.Fatalf("canonical role=%q err=%v", role, err)
	}
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := database.Model(&model.AppMemberRole{}).Where("role = ?", model.AppRoleAdmin).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("normalized duplicate bootstrap created %d admin assignments", count)
	}
}

func TestBootstrapAppAdminsRollsBackPartialFailureAndCanRetry(t *testing.T) {
	useAppRoleTestDB(t)
	savePortalMemberForAppRole(t, initialAdminUID, true)

	if err := BootstrapAppAdmins([]string{initialAdminUID, secondAdminUID}); err == nil {
		t.Fatal("bootstrap accepted an unsynchronized second administrator")
	}
	role, err := ResolveAppRole(initialAdminUID)
	if err != nil || role != model.AppRoleMember {
		t.Fatalf("partial bootstrap role=%q err=%v", role, err)
	}

	savePortalMemberForAppRole(t, secondAdminUID, true)
	if err := BootstrapAppAdmins([]string{initialAdminUID, secondAdminUID}); err != nil {
		t.Fatalf("bootstrap retry failed: %v", err)
	}
	for _, userUID := range []string{initialAdminUID, secondAdminUID} {
		role, err := ResolveAppRole(userUID)
		if err != nil || role != model.AppRoleAdmin {
			t.Fatalf("retry role for %s=%q err=%v", userUID, role, err)
		}
	}
}

func TestBootstrapAppAdminsRequiresEnabledSynchronizedMembers(t *testing.T) {
	t.Run("unsynchronized", func(t *testing.T) {
		useAppRoleTestDB(t)
		if err := BootstrapAppAdmins([]string{initialAdminUID}); err == nil {
			t.Fatal("unsynchronized initial administrator was accepted")
		}
	})

	t.Run("disabled", func(t *testing.T) {
		useAppRoleTestDB(t)
		savePortalMemberForAppRole(t, disabledAdminUID, false)
		if err := BootstrapAppAdmins([]string{disabledAdminUID}); err == nil {
			t.Fatal("disabled initial administrator was accepted")
		}
	})
}

func TestLastAdminConcurrentDemotionsCannotRemoveEveryAdmin(t *testing.T) {
	useAppRoleTestDB(t)
	savePortalMemberForAppRole(t, initialAdminUID, true)
	savePortalMemberForAppRole(t, secondAdminUID, true)
	if err := BootstrapAppAdmins([]string{initialAdminUID, secondAdminUID}); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	mutationResults := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for _, mutation := range []struct {
		targetUID    string
		grantedByUID string
	}{
		{targetUID: initialAdminUID, grantedByUID: secondAdminUID},
		{targetUID: secondAdminUID, grantedByUID: initialAdminUID},
	} {
		mutation := mutation
		go func() {
			ready.Done()
			<-start
			mutationResults <- SetAppRole(mutation.targetUID, model.AppRoleMember, mutation.grantedByUID, false)
		}()
	}
	ready.Wait()
	close(start)
	results := make([]error, 0, 2)
	for range 2 {
		results = append(results, <-mutationResults)
	}
	successCount := 0
	lastAdminCount := 0
	for _, err := range results {
		switch {
		case err == nil:
			successCount++
		case errors.Is(err, ErrLastAppAdmin):
			lastAdminCount++
		default:
			t.Fatalf("concurrent demotion returned unexpected error: %v", err)
		}
	}
	if successCount != 1 || lastAdminCount != 1 {
		t.Fatalf("concurrent demotion outcomes=%v, want one success and one ErrLastAppAdmin", results)
	}

	adminCount := 0
	for _, userUID := range []string{initialAdminUID, secondAdminUID} {
		role, err := ResolveAppRole(userUID)
		if err != nil {
			t.Fatal(err)
		}
		if role == model.AppRoleAdmin {
			adminCount++
		}
	}
	if adminCount == 0 {
		t.Fatal("concurrent demotions removed every administrator")
	}
}

func TestLastEnabledAdminCannotBeDemotedWhenAnotherExplicitAdminIsDisabled(t *testing.T) {
	useAppRoleTestDB(t)
	savePortalMemberForAppRole(t, initialAdminUID, true)
	savePortalMemberForAppRole(t, secondAdminUID, true)
	if err := BootstrapAppAdmins([]string{initialAdminUID, secondAdminUID}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertPortalMembers([]model.PortalMember{
		{UserUID: secondAdminUID, DisplayName: secondAdminUID, Enabled: false, Roles: []string{}},
	}); err != nil {
		t.Fatal(err)
	}

	err := SetAppRole(initialAdminUID, model.AppRoleMember, secondAdminUID, false)
	if !errors.Is(err, ErrLastAppAdmin) {
		t.Fatalf("SetAppRole() error = %v, want ErrLastAppAdmin", err)
	}
	role, err := ResolveAppRole(initialAdminUID)
	if err != nil || role != model.AppRoleAdmin {
		t.Fatalf("enabled administrator role = %q, err=%v; want unchanged admin", role, err)
	}
	disabledRole, err := ResolveAppRole(secondAdminUID)
	if err != nil || disabledRole != model.AppRoleAdmin {
		t.Fatalf("disabled member explicit role = %q, err=%v; want preserved admin", disabledRole, err)
	}
}

func TestBulkSyncCanDisableOneAdminBeforeRemainingAdminDemotion(t *testing.T) {
	useAppRoleTestDB(t)
	savePortalMemberForAppRole(t, initialAdminUID, true)
	savePortalMemberForAppRole(t, secondAdminUID, true)
	if err := BootstrapAppAdmins([]string{initialAdminUID, secondAdminUID}); err != nil {
		t.Fatal(err)
	}
	if err := SyncPortalMembers([]model.PortalMember{{
		UserUID: initialAdminUID, DisplayName: initialAdminUID, Enabled: true, Roles: []string{},
	}}); err != nil {
		t.Fatal(err)
	}

	if err := SetAppRole(initialAdminUID, model.AppRoleMember, secondAdminUID, false); !errors.Is(err, ErrLastAppAdmin) {
		t.Fatalf("SetAppRole() error = %v, want ErrLastAppAdmin", err)
	}
	role, err := ResolveAppRole(initialAdminUID)
	if err != nil || role != model.AppRoleAdmin {
		t.Fatalf("remaining enabled administrator role = %q, err=%v", role, err)
	}
	disabled, found, err := GetPortalMember(secondAdminUID)
	if err != nil || !found || disabled.Enabled {
		t.Fatalf("synchronized disabled administrator = %+v, found=%t, err=%v", disabled, found, err)
	}
}

func TestPortalMemberWritesDisableLastAdminAfterOtherDemotion(t *testing.T) {
	for _, test := range []struct {
		name    string
		disable func(t *testing.T) error
	}{
		{
			name: "upsert",
			disable: func(t *testing.T) error {
				return UpsertPortalMembers([]model.PortalMember{{
					UserUID: secondAdminUID, DisplayName: "updated disabled admin", Enabled: false, Roles: []string{"changed"},
				}})
			},
		},
		{
			name: "bulk sync",
			disable: func(t *testing.T) error {
				return SyncPortalMembers([]model.PortalMember{{
					UserUID: initialAdminUID, DisplayName: initialAdminUID, Enabled: true, Roles: []string{},
				}})
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			useAppRoleTestDB(t)
			savePortalMemberForAppRole(t, initialAdminUID, true)
			savePortalMemberForAppRole(t, secondAdminUID, true)
			if err := BootstrapAppAdmins([]string{initialAdminUID, secondAdminUID}); err != nil {
				t.Fatal(err)
			}
			if err := SetAppRole(initialAdminUID, model.AppRoleMember, secondAdminUID, false); err != nil {
				t.Fatal(err)
			}

			if err := test.disable(t); err != nil {
				t.Fatal(err)
			}
			member, found, err := GetPortalMember(secondAdminUID)
			if err != nil || !found || member.Enabled {
				t.Fatalf("last enabled administrator member = %+v, found=%t, err=%v; want disabled member and preserved role", member, found, err)
			}
			role, err := ResolveAppRole(secondAdminUID)
			if err != nil || role != model.AppRoleAdmin {
				t.Fatalf("last enabled administrator role = %q, err=%v", role, err)
			}
		})
	}
}

func TestPortalMemberSyncAllowsStateThatAlreadyHasNoEnabledAdmins(t *testing.T) {
	useAppRoleTestDB(t)
	const memberUID = "member-without-initial-admin"
	if err := UpsertPortalMembers([]model.PortalMember{{
		UserUID: memberUID, DisplayName: "初始成员", Enabled: true, Roles: []string{},
	}}); err != nil {
		t.Fatalf("initial member upsert failed: %v", err)
	}
	if err := SyncPortalMembers(nil); err != nil {
		t.Fatalf("zero-admin directory sync failed: %v", err)
	}
	member, found, err := GetPortalMember(memberUID)
	if err != nil || !found || member.Enabled {
		t.Fatalf("zero-admin synchronized member = %+v, found=%t, err=%v", member, found, err)
	}
}

func TestRoleDemotionSerializesWithPortalMemberDisable(t *testing.T) {
	for _, test := range []struct {
		name    string
		disable func() error
	}{
		{
			name: "upsert",
			disable: func() error {
				return UpsertPortalMembers([]model.PortalMember{{
					UserUID: secondAdminUID, DisplayName: "updated disabled admin", Enabled: false, Roles: []string{"changed"},
				}})
			},
		},
		{
			name: "bulk sync",
			disable: func() error {
				return SyncPortalMembers([]model.PortalMember{{
					UserUID: initialAdminUID, DisplayName: initialAdminUID, Enabled: true, Roles: []string{},
				}})
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			useAppRoleTestDB(t)
			savePortalMemberForAppRole(t, initialAdminUID, true)
			savePortalMemberForAppRole(t, secondAdminUID, true)
			if err := BootstrapAppAdmins([]string{initialAdminUID, secondAdminUID}); err != nil {
				t.Fatal(err)
			}
			database, err := DB()
			if err != nil {
				t.Fatal(err)
			}

			initialCountReached := make(chan struct{})
			releaseDemotion := make(chan struct{})
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(releaseDemotion) }) }
			memberCountBeforeLock := make(chan struct{}, 1)
			memberCountWhileDemotionPaused := make(chan struct{}, 1)
			var qualifiedCountCalls atomic.Int64
			var demotionPaused atomic.Bool
			var memberLockAttemptObserved atomic.Bool
			callbackSuffix := strings.ReplaceAll(test.name, " ", "-")
			queryCallbackName := "test:pause-role-demotion-count:" + callbackSuffix
			if err := database.Callback().Query().After("gorm:query").Register(queryCallbackName, func(tx *gorm.DB) {
				if tx.Statement == nil || tx.Statement.Schema == nil || tx.Statement.Schema.Table != "app_member_roles" {
					return
				}
				sql := strings.ToUpper(tx.Statement.SQL.String())
				if !strings.Contains(sql, "COUNT(") || !strings.Contains(sql, "JOIN PORTAL_MEMBERS") {
					return
				}
				if qualifiedCountCalls.Add(1) == 1 {
					demotionPaused.Store(true)
					close(initialCountReached)
					<-releaseDemotion
					demotionPaused.Store(false)
					return
				}
				if !memberLockAttemptObserved.Load() {
					select {
					case memberCountBeforeLock <- struct{}{}:
					default:
					}
				}
				if demotionPaused.Load() {
					select {
					case memberCountWhileDemotionPaused <- struct{}{}:
					default:
					}
				}
			}); err != nil {
				t.Fatal(err)
			}
			memberLockAttempted := make(chan struct{})
			var stateLockAttempts atomic.Int64
			createCallbackName := "test:observe-rbac-state-lock:" + callbackSuffix
			if err := database.Callback().Create().Before("gorm:create").Register(createCallbackName, func(tx *gorm.DB) {
				if tx.Statement == nil || tx.Statement.Schema == nil || tx.Statement.Schema.Table != "app_rbac_state" {
					return
				}
				if stateLockAttempts.Add(1) == 2 {
					memberLockAttemptObserved.Store(true)
					close(memberLockAttempted)
				}
			}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				release()
				previousLogger := database.Logger
				database.Logger = logger.Default.LogMode(logger.Silent)
				_ = database.Callback().Query().Remove(queryCallbackName)
				_ = database.Callback().Create().Remove(createCallbackName)
				database.Logger = previousLogger
			})

			demotionResult := make(chan error, 1)
			go func() {
				demotionResult <- SetAppRole(initialAdminUID, model.AppRoleMember, secondAdminUID, false)
			}()
			select {
			case <-initialCountReached:
			case err := <-demotionResult:
				release()
				t.Fatalf("demotion completed before count barrier: %v", err)
			case <-time.After(2 * time.Second):
				release()
				t.Fatal("demotion did not reach the enabled-admin count barrier")
			}

			writeResult := make(chan error, 1)
			go func() {
				writeResult <- test.disable()
			}()
			finishConcurrentOperations := func() {
				release()
				select {
				case <-demotionResult:
				case <-time.After(2 * time.Second):
				}
				select {
				case <-writeResult:
				case <-time.After(2 * time.Second):
				}
			}
			select {
			case <-memberLockAttempted:
			case writeErr := <-writeResult:
				release()
				<-demotionResult
				if writeErr == nil {
					t.Fatal("Portal member disable committed without acquiring the shared RBAC state lock")
				}
				t.Fatalf("Portal member disable failed before acquiring the shared RBAC state lock: %v", writeErr)
			case <-time.After(2 * time.Second):
				release()
				<-demotionResult
				t.Fatal("Portal member disable did not attempt to acquire the shared RBAC state lock")
			}
			select {
			case <-memberCountBeforeLock:
				finishConcurrentOperations()
				t.Fatal("Portal member writer counted enabled administrators before attempting the shared RBAC state lock")
			default:
			}
			var writeErr error
			select {
			case writeErr = <-writeResult:
				release()
				<-demotionResult
				t.Fatalf("Portal member disable returned while role demotion held the RBAC state lock: %v", writeErr)
			case <-time.After(150 * time.Millisecond):
			}
			select {
			case <-memberCountWhileDemotionPaused:
				finishConcurrentOperations()
				t.Fatal("Portal member writer counted enabled administrators while role demotion held the shared RBAC state lock")
			default:
			}

			release()
			if err := <-demotionResult; err != nil {
				t.Fatalf("demotion after count barrier failed: %v", err)
			}
			select {
			case writeErr = <-writeResult:
			case <-time.After(2 * time.Second):
				t.Fatal("Portal member disable did not finish after role demotion released the RBAC state lock")
			}
			if writeErr != nil {
				t.Fatal(writeErr)
			}
			if got := qualifiedCountCalls.Load(); got != 2 {
				t.Fatalf("enabled-admin counts=%d, want only the local role change before/after checks", got)
			}
			member, found, err := GetPortalMember(secondAdminUID)
			if err != nil || !found || member.Enabled {
				t.Fatalf("last enabled administrator member = %+v, found=%t, err=%v; want disabled member and preserved role", member, found, err)
			}
			role, err := ResolveAppRole(secondAdminUID)
			if err != nil || role != model.AppRoleAdmin {
				t.Fatalf("last enabled administrator role = %q, err=%v", role, err)
			}
		})
	}
}
