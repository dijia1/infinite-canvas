package model

// PublicFolder groups public library images. An empty ParentID represents the root.
type PublicFolder struct {
	ID        string `json:"id" gorm:"primaryKey"`
	ParentID  string `json:"parentId" gorm:"uniqueIndex:idx_public_folder_parent_title"`
	Title     string `json:"title" gorm:"uniqueIndex:idx_public_folder_parent_title"`
	CreatedAt string `json:"createdAt"`
}

type PublicFolderList struct {
	Items []PublicFolder `json:"items"`
	Total int            `json:"total"`
}
