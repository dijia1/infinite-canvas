package service

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

var portalDirectoryClient = &http.Client{Timeout: 5 * time.Second}

type directoryUser struct {
	UserUID     string   `json:"userUid"`
	DisplayName string   `json:"displayName"`
	Enabled     bool     `json:"enabled"`
	Roles       []string `json:"roles"`
}

type directoryResponse struct {
	Users []directoryUser `json:"users"`
}

type DirectorySyncResult struct {
	Count    int       `json:"count"`
	SyncedAt time.Time `json:"syncedAt"`
}

func portalDirectoryConfig() (string, string, string, error) {
	url := strings.TrimSpace(config.Cfg.PortalDirectoryURL)
	appKey := strings.TrimSpace(config.Cfg.PortalDirectoryAppKey)
	secret := strings.TrimSpace(config.Cfg.PortalDirectorySecret)
	if url == "" || appKey == "" || secret == "" {
		return "", "", "", errors.New("Portal 用户目录配置不完整")
	}
	return url, appKey, secret, nil
}

func fetchDirectoryUsers(ctx context.Context) ([]directoryUser, error) {
	url, appKey, secret, err := portalDirectoryConfig()
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("Portal 用户目录请求无效: %w", err)
	}
	request.Header.Set("X-Portal-Service-Key", appKey)
	request.Header.Set("X-Portal-Service-Secret", secret)
	response, err := portalDirectoryClient.Do(request)
	if err != nil {
		return nil, errors.New("Portal 用户目录同步失败")
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, errors.New("Portal 用户目录同步失败")
	}
	var payload directoryResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil || payload.Users == nil {
		return nil, errors.New("Portal 用户目录响应无效")
	}
	unique := make(map[string]directoryUser, len(payload.Users))
	for _, item := range payload.Users {
		if _, err := uuid.Parse(strings.TrimSpace(item.UserUID)); err != nil || strings.TrimSpace(item.DisplayName) == "" || item.Roles == nil {
			return nil, errors.New("Portal 用户目录响应无效")
		}
		for _, role := range item.Roles {
			if strings.TrimSpace(role) == "" {
				return nil, errors.New("Portal 用户目录响应无效")
			}
		}
		unique[item.UserUID] = directoryUser{UserUID: item.UserUID, DisplayName: strings.TrimSpace(item.DisplayName), Enabled: item.Enabled, Roles: append([]string(nil), item.Roles...)}
	}
	result := make([]directoryUser, 0, len(unique))
	for _, item := range unique {
		result = append(result, item)
	}
	return result, nil
}

func SyncPortalMembers(ctx context.Context) (DirectorySyncResult, error) {
	users, err := fetchDirectoryUsers(ctx)
	if err != nil {
		return DirectorySyncResult{}, err
	}
	syncedAt := time.Now().UTC()
	items := make([]model.PortalMember, 0, len(users))
	for _, user := range users {
		items = append(items, model.PortalMember{UserUID: user.UserUID, DisplayName: user.DisplayName, Enabled: user.Enabled, Roles: user.Roles, SyncedAt: syncedAt})
	}
	if err := repository.SyncPortalMembers(items); err != nil {
		return DirectorySyncResult{}, err
	}
	return DirectorySyncResult{Count: len(items), SyncedAt: syncedAt}, nil
}

func SyncPortalMember(ctx context.Context, userUID string) error {
	userUID = strings.TrimSpace(userUID)
	if _, err := uuid.Parse(userUID); err != nil {
		return safeMessageError{message: "用户标识无效"}
	}
	users, err := fetchDirectoryUsers(ctx)
	if err != nil {
		return err
	}
	syncedAt := time.Now().UTC()
	for _, user := range users {
		if user.UserUID == userUID {
			return repository.UpsertPortalMembers([]model.PortalMember{{UserUID: user.UserUID, DisplayName: user.DisplayName, Enabled: user.Enabled, Roles: user.Roles, SyncedAt: syncedAt}})
		}
	}
	member, found, err := repository.GetPortalMember(userUID)
	if err != nil || !found {
		return err
	}
	member.Enabled = false
	member.SyncedAt = syncedAt
	return repository.UpsertPortalMembers([]model.PortalMember{member})
}

func ListPortalMembers(query model.PortalMemberQuery) (model.PortalMemberList, error) {
	items, total, err := repository.ListPortalMembers(query)
	if err != nil {
		return model.PortalMemberList{}, err
	}
	for index := range items {
		if items[index].Roles == nil {
			items[index].Roles = []string{}
		}
	}
	return model.PortalMemberList{Items: items, Total: int(total)}, nil
}

func PortalDisplayName(user PortalUser) string {
	member, found, err := repository.GetPortalMember(user.UID)
	if err == nil && found && strings.TrimSpace(member.DisplayName) != "" {
		return member.DisplayName
	}
	if username := strings.TrimSpace(user.Username); username != "" {
		return username
	}
	return user.UID
}

func ValidDirectoryServiceHeaders(serviceKey, serviceSecret string) bool {
	_, appKey, secret, err := portalDirectoryConfig()
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(serviceKey), []byte(appKey)) == 1 && subtle.ConstantTimeCompare([]byte(serviceSecret), []byte(secret)) == 1
}
