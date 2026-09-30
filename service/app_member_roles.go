package service

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type appMemberRoleValidationError struct {
	message string
}

func (err appMemberRoleValidationError) Error() string       { return err.message }
func (err appMemberRoleValidationError) SafeMessage() string { return err.message }

func IsAppMemberRoleValidationError(err error) bool {
	var validationError appMemberRoleValidationError
	return errors.As(err, &validationError)
}

func SetPortalMemberAppRole(ctx context.Context, targetUID string, role model.AppRole) (model.PortalMemberWithAppRole, error) {
	if !validAppRole(role) {
		return model.PortalMemberWithAppRole{}, appMemberRoleValidationError{message: "应用角色无效"}
	}
	targetUID = strings.TrimSpace(targetUID)
	if targetUID == "" {
		return model.PortalMemberWithAppRole{}, appMemberRoleValidationError{message: "目标成员无效"}
	}
	member, found, err := repository.GetPortalMember(targetUID)
	if err != nil {
		return model.PortalMemberWithAppRole{}, err
	}
	if !found || !member.Enabled {
		return model.PortalMemberWithAppRole{}, appMemberRoleValidationError{message: "目标成员不存在或已停用"}
	}
	actor, ok := PortalUserFromContext(ctx)
	if !ok || strings.TrimSpace(actor.UID) == "" {
		return model.PortalMemberWithAppRole{}, errors.New("missing Portal actor for application role change")
	}
	if err := repository.SetAppRole(member.UserUID, role, actor.UID, slices.Contains(actor.Roles, "portal-admin")); err != nil {
		return model.PortalMemberWithAppRole{}, err
	}
	if member.Roles == nil {
		member.Roles = []string{}
	}
	return model.PortalMemberWithAppRole{PortalMember: member, AppRole: role}, nil
}

func validAppRole(role model.AppRole) bool {
	switch role {
	case model.AppRoleMember, model.AppRolePublicAssetsManager, model.AppRoleAdmin:
		return true
	default:
		return false
	}
}
