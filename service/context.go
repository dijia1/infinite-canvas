package service

import (
	"context"
	"strings"
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

func WithPortalUser(ctx context.Context, user PortalUser) context.Context {
	return context.WithValue(ctx, portalUserContextKey{}, user)
}

func PortalUserFromContext(ctx context.Context) (PortalUser, bool) {
	user, ok := ctx.Value(portalUserContextKey{}).(PortalUser)
	return user, ok
}
