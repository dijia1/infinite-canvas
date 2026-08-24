package service

import (
	"context"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
)

type portalUserContextKey struct{}

type PortalUser struct {
	UID      string   `json:"uid"`
	Username string   `json:"username"`
	Roles    []string `json:"roles"`
}

func (user PortalUser) HasRole(role string) bool {
	for _, candidate := range user.Roles {
		if strings.EqualFold(candidate, strings.TrimSpace(role)) {
			return true
		}
	}
	return false
}

func IsPortalAdmin(user PortalUser) bool {
	role := strings.TrimSpace(config.Cfg.PortalAdminRole)
	if role == "" {
		role = "portal-admin"
	}
	return user.HasRole(role)
}

func WithPortalUser(ctx context.Context, user PortalUser) context.Context {
	return context.WithValue(ctx, portalUserContextKey{}, user)
}

func PortalUserFromContext(ctx context.Context) (PortalUser, bool) {
	user, ok := ctx.Value(portalUserContextKey{}).(PortalUser)
	return user, ok
}
