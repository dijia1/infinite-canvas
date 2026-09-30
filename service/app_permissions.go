package service

import (
	"context"
	"fmt"
	"slices"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type AppPermissions struct {
	AppRole               model.AppRole `json:"appRole"`
	IsAdmin               bool          `json:"isAdmin"`
	CanManagePublicAssets bool          `json:"canManagePublicAssets"`
}

func ResolveAppPermissions(_ context.Context, user PortalUser) (AppPermissions, error) {
	// Gateway entry authorization and signature verification precede this call.
	// Directory synchronization may lag; a verified global admin must not be locked out.
	if slices.Contains(user.Roles, "portal-admin") {
		return AppPermissions{AppRole: model.AppRoleAdmin, IsAdmin: true, CanManagePublicAssets: true}, nil
	}
	member, found, err := repository.GetPortalMember(user.UID)
	if err != nil {
		return AppPermissions{}, err
	}
	if !found || !member.Enabled {
		return memberAppPermissions(), nil
	}

	role, err := repository.ResolveAppRole(user.UID)
	if err != nil {
		return AppPermissions{}, err
	}
	switch role {
	case model.AppRoleMember:
		return memberAppPermissions(), nil
	case model.AppRolePublicAssetsManager:
		return AppPermissions{AppRole: role, CanManagePublicAssets: true}, nil
	case model.AppRoleAdmin:
		return AppPermissions{AppRole: role, IsAdmin: true, CanManagePublicAssets: true}, nil
	default:
		return AppPermissions{}, fmt.Errorf("invalid stored application role %q for user %q", role, user.UID)
	}
}

func memberAppPermissions() AppPermissions {
	return AppPermissions{AppRole: model.AppRoleMember}
}
