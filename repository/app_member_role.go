package repository

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const appRBACStateSingletonID uint = 1

var ErrLastAppAdmin = errors.New("cannot remove the final application administrator")

func AppRBACBootstrapCompleted() (bool, error) {
	database, err := DB()
	if err != nil {
		return false, err
	}
	state := model.AppRBACState{}
	result := database.Select("bootstrap_completed_at").Where("id = ?", appRBACStateSingletonID).Limit(1).Find(&state)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0 && state.BootstrapCompletedAt != nil, nil
}

func ResolveAppRole(userUID string) (model.AppRole, error) {
	database, err := DB()
	if err != nil {
		return "", err
	}
	assignment := model.AppMemberRole{}
	result := database.Where("user_uid = ?", userUID).Limit(1).Find(&assignment)
	if result.Error != nil {
		return "", result.Error
	}
	if result.RowsAffected == 0 {
		return model.AppRoleMember, nil
	}
	return assignment.Role, nil
}

func ListAppRoles(userUIDs []string) (map[string]model.AppRole, error) {
	roles := make(map[string]model.AppRole, len(userUIDs))
	uniqueUIDs := make([]string, 0, len(userUIDs))
	seen := make(map[string]struct{}, len(userUIDs))
	for _, userUID := range userUIDs {
		if _, exists := seen[userUID]; exists {
			continue
		}
		seen[userUID] = struct{}{}
		uniqueUIDs = append(uniqueUIDs, userUID)
		roles[userUID] = model.AppRoleMember
	}
	if len(uniqueUIDs) == 0 {
		return roles, nil
	}
	database, err := DB()
	if err != nil {
		return nil, err
	}
	assignments := make([]model.AppMemberRole, 0, len(uniqueUIDs))
	if err := database.Where("user_uid IN ?", uniqueUIDs).Find(&assignments).Error; err != nil {
		return nil, err
	}
	for _, assignment := range assignments {
		roles[assignment.UserUID] = assignment.Role
	}
	return roles, nil
}

func SetAppRole(userUID string, role model.AppRole, grantedByUID string, allowLastAdminRemoval bool) error {
	if !isValidAppRole(role) {
		return fmt.Errorf("invalid application role %q", role)
	}
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Transaction(func(transaction *gorm.DB) error {
		if _, err := lockAppRBACState(transaction); err != nil {
			return err
		}
		enabledAdminCount, err := countEnabledAppAdmins(transaction)
		if err != nil {
			return err
		}

		if role == model.AppRoleMember {
			if err := transaction.Where("user_uid = ?", userUID).Delete(&model.AppMemberRole{}).Error; err != nil {
				return err
			}
			if allowLastAdminRemoval {
				return nil
			}
			return protectEnabledAppAdmins(transaction, enabledAdminCount)
		}
		assignment := model.AppMemberRole{UserUID: userUID, Role: role, GrantedByUID: grantedByUID}
		if err := transaction.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_uid"}},
			DoUpdates: clause.AssignmentColumns([]string{"role", "granted_by_uid", "updated_at"}),
		}).Create(&assignment).Error; err != nil {
			return err
		}
		if allowLastAdminRemoval {
			return nil
		}
		return protectEnabledAppAdmins(transaction, enabledAdminCount)
	})
}

func countEnabledAppAdmins(transaction *gorm.DB) (int64, error) {
	var count int64
	err := transaction.Model(&model.AppMemberRole{}).
		Joins("JOIN portal_members ON portal_members.user_uid = app_member_roles.user_uid").
		Where("app_member_roles.role = ? AND portal_members.enabled = ?", model.AppRoleAdmin, true).
		Count(&count).Error
	return count, err
}

func protectEnabledAppAdmins(transaction *gorm.DB, previousCount int64) error {
	if previousCount == 0 {
		return nil
	}
	currentCount, err := countEnabledAppAdmins(transaction)
	if err != nil {
		return err
	}
	if currentCount == 0 {
		return ErrLastAppAdmin
	}
	return nil
}

func BootstrapAppAdmins(initialUIDs []string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Transaction(func(transaction *gorm.DB) error {
		state, err := lockAppRBACState(transaction)
		if err != nil {
			return err
		}
		return bootstrapAppAdminsLocked(transaction, state, initialUIDs)
	})
}

// BootstrapAppAdminsFromDirectory applies an already-fetched Portal directory
// snapshot only while the first local RBAC bootstrap is still pending.
func BootstrapAppAdminsFromDirectory(items []model.PortalMember, initialUIDs []string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Transaction(func(transaction *gorm.DB) error {
		state, err := lockAppRBACState(transaction)
		if err != nil {
			return err
		}
		if state.BootstrapCompletedAt != nil {
			return nil
		}
		if err := syncPortalMembersLocked(transaction, items); err != nil {
			return err
		}
		return bootstrapAppAdminsLocked(transaction, state, initialUIDs)
	})
}

func bootstrapAppAdminsLocked(transaction *gorm.DB, state model.AppRBACState, initialUIDs []string) error {
	if state.BootstrapCompletedAt != nil {
		return nil
	}

	userUIDs, err := normalizeBootstrapAdminUIDs(initialUIDs)
	if err != nil {
		return err
	}
	for _, userUID := range userUIDs {
		member := model.PortalMember{}
		result := transaction.Select("user_uid").Where("user_uid = ? AND enabled = ?", userUID, true).Limit(1).Find(&member)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return fmt.Errorf("APP_RBAC_INITIAL_ADMIN_UIDS user %q is not an enabled synchronized Portal member", userUID)
		}
	}

	now := time.Now().UTC()
	assignments := make([]model.AppMemberRole, 0, len(userUIDs))
	for _, userUID := range userUIDs {
		assignments = append(assignments, model.AppMemberRole{UserUID: userUID, Role: model.AppRoleAdmin})
	}
	if err := transaction.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_uid"}},
		DoUpdates: clause.AssignmentColumns([]string{"role", "granted_by_uid", "updated_at"}),
	}).Create(&assignments).Error; err != nil {
		return err
	}
	return transaction.Model(&model.AppRBACState{}).
		Where("id = ?", appRBACStateSingletonID).
		Updates(map[string]any{"bootstrap_completed_at": now, "updated_at": now}).Error
}

func lockAppRBACState(transaction *gorm.DB) (model.AppRBACState, error) {
	state := model.AppRBACState{ID: appRBACStateSingletonID}
	if err := transaction.Clauses(clause.OnConflict{DoNothing: true}).Create(&state).Error; err != nil {
		return model.AppRBACState{}, err
	}
	if err := transaction.Model(&model.AppRBACState{}).
		Where("id = ?", appRBACStateSingletonID).
		UpdateColumn("updated_at", time.Now().UTC()).Error; err != nil {
		return model.AppRBACState{}, err
	}
	if err := transaction.Where("id = ?", appRBACStateSingletonID).First(&state).Error; err != nil {
		return model.AppRBACState{}, err
	}
	return state, nil
}

func normalizeBootstrapAdminUIDs(initialUIDs []string) ([]string, error) {
	if len(initialUIDs) == 0 {
		return nil, errors.New("APP_RBAC_INITIAL_ADMIN_UIDS must contain at least one UUID before application RBAC bootstrap can complete")
	}
	result := make([]string, 0, len(initialUIDs))
	seen := make(map[string]struct{}, len(initialUIDs))
	for _, value := range initialUIDs {
		configuredUID := strings.TrimSpace(value)
		if configuredUID == "" {
			return nil, errors.New("APP_RBAC_INITIAL_ADMIN_UIDS must not contain an empty UID")
		}
		parsedUID, err := uuid.Parse(configuredUID)
		if err != nil {
			return nil, fmt.Errorf("APP_RBAC_INITIAL_ADMIN_UIDS contains invalid UUID %q", configuredUID)
		}
		userUID := parsedUID.String()
		if _, exists := seen[userUID]; exists {
			continue
		}
		seen[userUID] = struct{}{}
		result = append(result, userUID)
	}
	return result, nil
}

func isValidAppRole(role model.AppRole) bool {
	switch role {
	case model.AppRoleMember, model.AppRolePublicAssetsManager, model.AppRoleAdmin:
		return true
	default:
		return false
	}
}
