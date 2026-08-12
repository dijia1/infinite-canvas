package model

type UserRole string

const (
	UserRoleAdmin UserRole = "admin"
)

type UserStatus string

const (
	UserStatusActive UserStatus = "active"
)

// User 管理员账号。
type User struct {
	ID          string     `json:"id" gorm:"primaryKey"`
	Username    string     `json:"username" gorm:"uniqueIndex"`
	Password    string     `json:"password,omitempty"`
	Role        UserRole   `json:"role"`
	Status      UserStatus `json:"status"`
	LastLoginAt string     `json:"lastLoginAt"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
}

// AuthUser 管理员公开信息。
type AuthUser struct {
	ID       string   `json:"id"`
	Username string   `json:"username"`
	Role     UserRole `json:"role"`
}

// AuthSession 登录会话信息。
type AuthSession struct {
	Token string   `json:"token"`
	User  AuthUser `json:"user"`
}

func PublicUser(user User) AuthUser {
	return AuthUser{
		ID:       user.ID,
		Username: user.Username,
		Role:     user.Role,
	}
}
